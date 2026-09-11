require('dotenv').config();
const express=require('express');
const Razorpay=require('razorpay');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
const PORT=process.env.PORT||3000;
const DATA=path.join(__dirname,'bookings.json');
function read(){try{return JSON.parse(fs.readFileSync(DATA,'utf8'))}catch{return []}}
function write(x){fs.writeFileSync(DATA,JSON.stringify(x,null,2))}
const rzp=(process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET)?
 new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET}):null;

app.post('/api/create-order',async(req,res)=>{
 try{
  const {name,age,gender,place,phone,email,plan,datetime,message}=req.body;
  const amount=plan&&plan.startsWith('3 Hours')?500:200;
  if(!name||!age||!gender||!place||!phone||!plan||!datetime) return res.status(400).json({error:'Please complete all required fields.'});
  if(!rzp) return res.status(503).json({error:'Payment gateway is not configured yet. Add Razorpay live/test keys to .env.'});
  const order=await rzp.orders.create({amount:amount*100,currency:'INR',receipt:'SL'+Date.now()});
  const bookings=read();
  bookings.push({id:order.id,name,age,gender,place,phone,email,plan,datetime,message,status:'pending',amount,createdAt:new Date().toISOString()});
  write(bookings);
  res.json({key:process.env.RAZORPAY_KEY_ID,orderId:order.id,amount:amount*100,currency:'INR'});
 }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/verify-payment',(req,res)=>{
 const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body;
 const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+'|'+razorpay_payment_id).digest('hex');
 if(expected!==razorpay_signature)return res.status(400).json({ok:false,error:'Payment verification failed.'});
 const bookings=read(); const b=bookings.find(x=>x.id===razorpay_order_id);
 if(b){b.status='paid';b.paymentId=razorpay_payment_id;b.paidAt=new Date().toISOString();write(bookings)}
 res.json({ok:true});
});

app.post('/api/webhook',(req,res)=>{
 const raw=JSON.stringify(req.body);
 const signature=req.headers['x-razorpay-signature'];
 if(process.env.RAZORPAY_WEBHOOK_SECRET){
  const expected=crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  if(expected!==signature)return res.status(400).send('invalid signature');
 }
 if(req.body.event==='order.paid'){
  const id=req.body.payload?.order?.entity?.id; const bookings=read(); const b=bookings.find(x=>x.id===id);
  if(b){b.status='paid';b.webhookReceivedAt=new Date().toISOString();write(bookings)}
 }
 res.json({received:true});
});

app.get('/api/bookings',(req,res)=>{
 if(!process.env.ADMIN_TOKEN || req.headers.authorization!=='Bearer '+process.env.ADMIN_TOKEN)return res.status(401).json({error:'Unauthorized'});
 res.json(read().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
});
app.listen(PORT,()=>console.log('Sidhh Listener running on '+PORT));
