require("dotenv").config();
const express=require("express"),http=require("http"),cors=require("cors"),jwt=require("jsonwebtoken");
const bcrypt=require("bcryptjs"),Database=require("better-sqlite3"),{Server}=require("socket.io");
const Razorpay=require("razorpay"),crypto=require("crypto"),path=require("path");
const app=express(),server=http.createServer(app),io=new Server(server,{cors:{origin:"*"}});
app.use(cors());app.use(express.json());app.use(express.static(path.join(__dirname,"public")));
const db=new Database("mazon.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT DEFAULT 'customer',active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS restaurants(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,address TEXT,lat REAL,lng REAL,owner_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS foods(id INTEGER PRIMARY KEY AUTOINCREMENT,restaurant_id INTEGER,name TEXT,category TEXT,price REAL,description TEXT,emoji TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,restaurant_id INTEGER,items TEXT,total REAL,address TEXT,lat REAL,lng REAL,payment_method TEXT,payment_status TEXT,status TEXT,delivery_partner_id INTEGER,razorpay_order_id TEXT,razorpay_payment_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,status TEXT,actor_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS delivery_locations(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,partner_id INTEGER,lat REAL,lng REAL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS verified_phones(phone TEXT PRIMARY KEY,verified_until INTEGER);
`);
function seed(){
 if(!db.prepare("SELECT 1 FROM restaurants LIMIT 1").get()){
  const r=db.prepare("INSERT INTO restaurants(name,address,lat,lng) VALUES(?,?,?,?)").run("Mazon Kitchen","Bhubaneswar, Odisha",20.2961,85.8245);
  const q=db.prepare("INSERT INTO foods(restaurant_id,name,category,price,description,emoji) VALUES(?,?,?,?,?,?)");
  [["Chicken Biryani","Biryani",149,"Fragrant chicken biryani","🍛"],["Veg Biryani","Biryani",119,"Aromatic vegetable biryani","🍛"],["Cheese Burger","Burger",129,"Cheesy classic burger","🍔"],["Chicken Burger","Burger",159,"Crispy chicken burger","🍔"],["Margherita Pizza","Pizza",199,"Tomato, cheese and herbs","🍕"],["Hakka Noodles","Chinese",139,"Wok-tossed noodles","🥡"],["Masala Dosa","Indian",99,"Crispy dosa with masala","🥘"]].forEach(x=>q.run(r.lastInsertRowid,...x));
 }
}
seed();

const sign=u=>jwt.sign({id:u.id,role:u.role,name:u.name},process.env.JWT_SECRET,{expiresIn:"7d"});
function auth(req,res,next){try{const h=req.headers.authorization||"";req.user=jwt.verify(h.startsWith("Bearer ")?h.slice(7):h,process.env.JWT_SECRET);next()}catch(e){res.status(401).json({error:"Login required"})}}
const roles=(...allowed)=>(req,res,next)=>allowed.includes(req.user.role)?next():res.status(403).json({error:"Not allowed"});
function emitOrder(o){io.to("order:"+o.id).emit("order:update",o);io.emit("orders:refresh");}
function getOrder(id){return db.prepare("SELECT o.*,r.name restaurant FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=?").get(id)}
function logStatus(orderId,status,actor){db.prepare("INSERT INTO order_events(order_id,status,actor_id) VALUES(?,?,?)").run(orderId,status,actor);db.prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,orderId)}

app.get("/api/health",(q,s)=>s.json({ok:true,name:"MAZON",version:"3.0"}));
app.get("/api/config",(q,s)=>s.json({
  razorpay:!!process.env.RAZORPAY_KEY_ID,
  maps:!!process.env.GOOGLE_MAPS_API_KEY,
  upi_id:process.env.MAZON_UPI_ID||"ranjaldigal-4@oksbi",
  upi_name:process.env.MAZON_UPI_NAME||"MAZON",
  whatsapp_otp:!!(process.env.WHATSAPP_PHONE_NUMBER_ID&&process.env.WHATSAPP_ACCESS_TOKEN)
}));
app.get("/api/foods",(q,s)=>s.json(db.prepare("SELECT f.*,r.name restaurant,r.address restaurant_address FROM foods f JOIN restaurants r ON r.id=f.restaurant_id WHERE f.active=1 AND r.active=1 ORDER BY f.id DESC").all()));
app.get("/api/restaurants",(q,s)=>s.json(db.prepare("SELECT * FROM restaurants WHERE active=1 ORDER BY id DESC").all()));
app.get("/api/payments/upi",(req,res)=>{
  const amount=Number(req.query.amount||0);
  const orderId=String(req.query.orderId||"");
  if(!amount || !orderId)return res.status(400).json({error:"amount and orderId required"});
  const pa=encodeURIComponent(process.env.MAZON_UPI_ID||"ranjaldigal-4@oksbi");
  const pn=encodeURIComponent(process.env.MAZON_UPI_NAME||"MAZON");
  const tn=encodeURIComponent("MAZON Food Order "+orderId);
  const uri=`upi://pay?pa=${pa}&pn=${pn}&am=${amount.toFixed(2)}&cu=INR&tn=${tn}`;
  res.json({upi_id:process.env.MAZON_UPI_ID||"ranjaldigal-4@oksbi",payee_name:process.env.MAZON_UPI_NAME||"MAZON",amount,upi_uri:uri,verification:"gateway_required"});
});

// WhatsApp OTP provider abstraction.
// A real WhatsApp Business/API provider must be configured before OTPs are sent.
// Never expose provider access tokens to the browser.
const otpStore=new Map();

async function sendWhatsAppOtp(phone,code){
  const id=process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token=process.env.WHATSAPP_ACCESS_TOKEN;
  const version=process.env.WHATSAPP_GRAPH_API_VERSION||"v23.0";
  const template=process.env.WHATSAPP_OTP_TEMPLATE||"mazon_otp";
  if(!id||!token) throw new Error("WhatsApp Business credentials are not configured");
  const url=`https://graph.facebook.com/${version}/${id}/messages`;
  const body={
    messaging_product:"whatsapp",
    to:phone,
    type:"template",
    template:{name:template,language:{code:process.env.WHATSAPP_OTP_LANGUAGE||"en_US"},components:[
      {type:"body",parameters:[{type:"text",text:code}]},
      {type:"button",sub_type:"url",index:"0",parameters:[{type:"text",text:code}]}
    ]}
  };
  const r=await fetch(url,{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error("WhatsApp API rejected the OTP request");
  return await r.json();
}

app.post("/api/auth/request-whatsapp-otp",async(req,res)=>{
  const phone=String(req.body.phone||"").replace(/\D/g,"");
  if(phone.length<10)return res.status(400).json({error:"Valid mobile number required"});
  const now=Date.now(),old=otpStore.get(phone);
  if(old && now-old.sentAt<60000)return res.status(429).json({error:"Please wait before requesting another OTP"});
  const code=String(Math.floor(100000+Math.random()*900000));
  otpStore.set(phone,{code,expires:now+5*60*1000,sentAt:now,attempts:0});
  try{
    await sendWhatsAppOtp(phone,code);
    res.json({sent:true,message:"OTP sent on WhatsApp"});
  }catch(e){
    otpStore.delete(phone);
    res.status(503).json({error:e.message});
  }
});

app.post("/api/auth/verify-whatsapp-otp",(req,res)=>{
  const phone=String(req.body.phone||"").replace(/\D/g,""),code=String(req.body.code||"");
  const x=otpStore.get(phone);
  if(!x||Date.now()>x.expires)return res.status(400).json({error:"OTP expired or not requested"});
  if(x.attempts>=5)return res.status(429).json({error:"Too many attempts"});
  x.attempts++;
  if(x.code!==code)return res.status(400).json({error:"Incorrect OTP"});
  otpStore.delete(phone);
  db.prepare("INSERT INTO verified_phones(phone,verified_until) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET verified_until=excluded.verified_until").run(phone,Date.now()+15*60*1000);
  res.json({verified:true});
});

function isPhoneVerified(phone){
  const x=db.prepare("SELECT verified_until FROM verified_phones WHERE phone=?").get(phone);
  return !!x && x.verified_until>Date.now();
}

app.post("/api/orders",auth,roles("customer"),(req,res)=>{
 let {restaurantId,items,total,address,lat=null,lng=null,paymentMethod="COD"}=req.body;
 if(!restaurantId||!Array.isArray(items)||!items.length||!address)return res.status(400).json({error:"Invalid order"});
 const ids=items.map(x=>x.id); const marks=ids.map(()=>"?").join(",");
 const dbFoods=db.prepare(`SELECT id,restaurant_id,price,name FROM foods WHERE id IN (${marks}) AND active=1`).all(...ids);
 if(dbFoods.length!==ids.length||dbFoods.some(x=>x.restaurant_id!=restaurantId))return res.status(400).json({error:"Cart contains invalid restaurant items"});
 const calculated=items.reduce((sum,x)=>sum+(dbFoods.find(f=>f.id==x.id).price*(x.qty||1)),0);
 if(Math.abs(Number(total)-calculated)>0.01)return res.status(400).json({error:"Order total mismatch"});
 const r=db.prepare(`INSERT INTO orders(customer_id,restaurant_id,items,total,address,lat,lng,payment_method,payment_status,status) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(req.user.id,restaurantId,JSON.stringify(items),calculated,address,lat,lng,paymentMethod,paymentMethod==="COD"?"PENDING":"UNPAID","PLACED");
 logStatus(r.lastInsertRowid,"PLACED",req.user.id); const o=getOrder(r.lastInsertRowid); emitOrder(o); res.json(o);
});
app.get("/api/orders",auth,(req,res)=>{
 let sql="SELECT o.*,r.name restaurant FROM orders o JOIN restaurants r ON r.id=o.restaurant_id ";
 if(req.user.role==="customer")res.json(db.prepare(sql+"WHERE o.customer_id=? ORDER BY o.id DESC").all(req.user.id));
 else if(req.user.role==="restaurant")res.json(db.prepare(sql+"WHERE o.restaurant_id IN (SELECT id FROM restaurants WHERE owner_id=?) ORDER BY o.id DESC").all(req.user.id));
 else if(req.user.role==="delivery")res.json(db.prepare(sql+"WHERE o.delivery_partner_id=? OR o.delivery_partner_id IS NULL ORDER BY o.id DESC").all(req.user.id));
 else res.json(db.prepare(sql+"ORDER BY o.id DESC").all());
});
app.get("/api/orders/:id",auth,(req,res)=>{
 const o=getOrder(req.params.id); if(!o)return res.status(404).json({error:"Not found"});
 if(req.user.role==="customer"&&o.customer_id!==req.user.id)return res.status(403).json({error:"Not allowed"});
 res.json(o);
});
app.get("/api/orders/:id/events",auth,(req,res)=>res.json(db.prepare("SELECT * FROM order_events WHERE order_id=? ORDER BY id").all(req.params.id)));

const statusByRole={
 restaurant:["ACCEPTED","PREPARING","READY","CANCELLED"],
 delivery:["PICKED_UP","OUT_FOR_DELIVERY","DELIVERED"],
 admin:["ACCEPTED","PREPARING","READY","PICKED_UP","OUT_FOR_DELIVERY","DELIVERED","CANCELLED"]
};
app.patch("/api/orders/:id/status",auth,(req,res)=>{
 const o=getOrder(req.params.id),status=req.body.status;
 if(!o)return res.status(404).json({error:"Not found"});
 if(!statusByRole[req.user.role]?.includes(status))return res.status(403).json({error:"This role cannot set that status"});
 if(req.user.role==="restaurant"){
  const own=db.prepare("SELECT 1 FROM restaurants WHERE id=? AND owner_id=?").get(o.restaurant_id,req.user.id); if(!own)return res.status(403).json({error:"Not your restaurant"});
 }
 if(req.user.role==="delivery" && o.delivery_partner_id && o.delivery_partner_id!==req.user.id)return res.status(403).json({error:"Not your delivery"});
 if(req.user.role==="delivery" && !o.delivery_partner_id)db.prepare("UPDATE orders SET delivery_partner_id=? WHERE id=?").run(req.user.id,o.id);
 logStatus(o.id,status,req.user.id); const updated=getOrder(o.id); emitOrder(updated); res.json(updated);
});

app.post("/api/orders/:id/assign",auth,roles("admin"),(req,res)=>{
 const o=getOrder(req.params.id); if(!o)return res.status(404).json({error:"Not found"});
 const p=db.prepare("SELECT id FROM users WHERE id=? AND role='delivery' AND active=1").get(req.body.deliveryPartnerId);
 if(!p)return res.status(400).json({error:"Invalid delivery partner"});
 db.prepare("UPDATE orders SET delivery_partner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id,o.id);
 emitOrder(getOrder(o.id));res.json(getOrder(o.id));
});
app.post("/api/orders/:id/location",auth,roles("delivery"),(req,res)=>{
 const o=getOrder(req.params.id); if(!o)return res.status(404).json({error:"Not found"});
 if(o.delivery_partner_id!==req.user.id)return res.status(403).json({error:"Not your delivery"});
 const {lat,lng}=req.body;if(typeof lat!=="number"||typeof lng!=="number")return res.status(400).json({error:"lat/lng required"});
 db.prepare("INSERT INTO delivery_locations(order_id,partner_id,lat,lng) VALUES(?,?,?,?)").run(o.id,req.user.id,lat,lng);
 io.to("order:"+o.id).emit("delivery:location",{orderId:o.id,lat,lng});res.json({ok:true});
});

app.get("/api/orders/:id/locations",auth,(req,res)=>res.json(db.prepare("SELECT lat,lng,created_at FROM delivery_locations WHERE order_id=? ORDER BY id DESC LIMIT 100").all(req.params.id)));

app.post("/api/payments/create-order",auth,roles("customer"),async(req,res)=>{
 if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)return res.status(503).json({error:"Razorpay is not configured"});
 const rz=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
 try{const r=await rz.orders.create({amount:Math.round(Number(req.body.amount)*100),currency:"INR",receipt:"MZ"+Date.now()});res.json(r)}
 catch(e){res.status(500).json({error:"Payment order failed"})}
});
app.post("/api/payments/verify",auth,roles("customer"),(req,res)=>{
 const {orderId,razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body;
 if(!process.env.RAZORPAY_KEY_SECRET)return res.status(503).json({error:"Razorpay is not configured"});
 const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+"|"+razorpay_payment_id).digest("hex");
 if(expected!==razorpay_signature)return res.status(400).json({error:"Invalid payment signature"});
 const o=getOrder(orderId);if(!o||o.customer_id!==req.user.id)return res.status(404).json({error:"Order not found"});
 db.prepare("UPDATE orders SET payment_status='PAID',razorpay_order_id=?,razorpay_payment_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(razorpay_order_id,razorpay_payment_id,orderId);
 emitOrder(getOrder(orderId));res.json({ok:true});
});

app.get("/api/payments/status/:razorpayPaymentId",auth,roles("customer","admin"),async(req,res)=>{
  if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)return res.status(503).json({error:"Razorpay is not configured"});
  try{
    const rz=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const p=await rz.payments.fetch(req.params.razorpayPaymentId);
    res.json({id:p.id,status:p.status,captured:p.captured,amount:p.amount,currency:p.currency,method:p.method});
  }catch(e){res.status(404).json({error:"Payment not found"})}
});

app.post("/api/payments/webhook",(req,res)=>{
 // Production: configure Razorpay webhook secret and verify the raw request body before trusting events.
 res.json({ok:true});
});

app.get("/api/admin/stats",auth,roles("admin"),(req,res)=>{
 const users=db.prepare("SELECT role,COUNT(*) count FROM users GROUP BY role").all();
 const orders=db.prepare("SELECT status,COUNT(*) count FROM orders GROUP BY status").all();
 const revenue=db.prepare("SELECT COALESCE(SUM(total),0) total FROM orders WHERE payment_status='PAID' OR payment_method='COD'").get().total;
 res.json({users,orders,revenue});
});
app.get("/api/admin/users",auth,roles("admin"),(req,res)=>res.json(db.prepare("SELECT id,name,phone,role,active,created_at FROM users ORDER BY id DESC").all()));
app.get("/api/admin/restaurants",auth,roles("admin"),(req,res)=>res.json(db.prepare("SELECT r.*,u.name owner FROM restaurants r LEFT JOIN users u ON u.id=r.owner_id ORDER BY r.id DESC").all()));
app.post("/api/restaurants",auth,roles("admin"),(req,res)=>{
 const {name,address,lat=null,lng=null,ownerId=null}=req.body;if(!name)return res.status(400).json({error:"Name required"});
 const r=db.prepare("INSERT INTO restaurants(name,address,lat,lng,owner_id) VALUES(?,?,?,?,?)").run(name,address||"",lat,lng,ownerId);res.json(db.prepare("SELECT * FROM restaurants WHERE id=?").get(r.lastInsertRowid));
});
app.post("/api/restaurants/:id/foods",auth,roles("admin","restaurant"),(req,res)=>{
 const r=db.prepare("SELECT * FROM restaurants WHERE id=?").get(req.params.id);if(!r)return res.status(404).json({error:"Restaurant not found"});
 if(req.user.role==="restaurant"&&r.owner_id!==req.user.id)return res.status(403).json({error:"Not your restaurant"});
 const {name,category,price,description="",emoji="🍽️"}=req.body;if(!name||!price)return res.status(400).json({error:"Name and price required"});
 const x=db.prepare("INSERT INTO foods(restaurant_id,name,category,price,description,emoji) VALUES(?,?,?,?,?,?)").run(r.id,name,category||"Other",price,description,emoji);
 res.json(db.prepare("SELECT * FROM foods WHERE id=?").get(x.lastInsertRowid));
});

app.post("/api/dev/create-admin",async(req,res)=>{
 // For first local setup only. Disable/remove this endpoint before production.
 const exists=db.prepare("SELECT 1 FROM users WHERE role='admin'").get();if(exists)return res.status(409).json({error:"Admin already exists"});
 const {name="MAZON Admin",phone,password="admin123"}=req.body;const p=await bcrypt.hash(password,10);
 const x=db.prepare("INSERT INTO users(name,phone,password,role) VALUES(?,?,?,'admin')").run(name,phone,p);res.json({message:"Admin created",phone,password});
});

io.on("connection",s=>{
 s.on("joinOrder",id=>s.join("order:"+id));
 s.on("leaveOrder",id=>s.leave("order:"+id));
});
server.listen(process.env.PORT||3000,()=>console.log("MAZON v3 running on "+(process.env.PORT||3000)));
