require('dotenv').config();
const express = require('express');
const { middleware: lineMiddleware, Client: LineClient } = require('@line/bot-sdk');
const { SessionsClient } = require('@google-cloud/dialogflow');
const mysql = require('mysql2/promise');

const app = express();

// LINE SDK config
const lineConfig = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

// Dialogflow client
const dfClient = new SessionsClient();

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// Webhook handler
app.post('/webhook',
  lineMiddleware(lineConfig),    // ตรวจ signature & parse body
  async (req, res) => {
    const events = req.body.events;
    const lineClient = new LineClient(lineConfig);

    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text;
      const ts = new Date(event.timestamp);

      // ดึงชื่อผู้ใช้จาก Profile API
      let userName = null;
      try {
        const profile = await lineClient.getProfile(userId);
        userName = profile.displayName;
      } catch (err) {
        console.warn('Cannot fetch profile:', err.toString());
      }

      // เรียก Dialogflow เพื่อประมวลผล intent (แต่เราไม่เก็บ intent)
      const sessionPath = dfClient.projectAgentSessionPath(
        process.env.GOOGLE_PROJECT_ID,
        userId
      );
      const [dfResponse] = await dfClient.detectIntent({
        session: sessionPath,
        queryInput: { text: { text, languageCode: 'th-TH' } },
      });
      const replyText = dfResponse.queryResult.fulfillmentText || 'ขออภัย ไม่เข้าใจ';

      // บันทึกลงฐานข้อมูลเฉพาะ session_id, user_id, userName, text, timestamp
      try {
        await pool.execute(
          `INSERT INTO chat_logs
            (session_id, user_id, username, text, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, userId, userName, text, ts]
        );
      } catch (err) {
        console.error('DB error:', err);
      }

      // ตอบกลับผู้ใช้ผ่าน LINE
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText,
      });
    }

    // ตอบ 200 OK เพื่อหยุด LINE retry
    res.sendStatus(200);
  }
);

// GET /messages → ดึง chat_logs ทั้งหมด
app.get('/messages', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM chat_logs ORDER BY timestamp DESC');  // :contentReference[oaicite:3]{index=3}
    res.json(rows);
  } catch (err) {
    console.error('DB query error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// — ดึงหมวดหมู่
app.get('/api/categories', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM categories');
  res.json(rows);
});

// — ดึงสินค้าทั้งหมด หรือกรองตาม category
app.get('/api/products', async (req, res) => {
  const { categoryId } = req.query;
  let sql = 'SELECT * FROM products';
  const params = [];
  if (categoryId) {
    sql += ' WHERE category_id = ?';
    params.push(categoryId);
  }
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

// — เพิ่มสินค้าใหม่
app.post('/api/products', async (req, res) => {
  const { category_id, name, description, price, stock } = req.body;
  const [result] = await pool.execute(
    'INSERT INTO products (category_id,name,description,price,stock) VALUES (?,?,?,?,?)',
    [category_id, name, description, price, stock]
  );
  res.json({ id: result.insertId });
});

// — สร้างคำสั่งซื้อ
app.post('/api/orders', async (req, res) => {
  const { customer_name, items } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orderRes] = await conn.execute(
      'INSERT INTO orders (customer_name) VALUES (?)',
      [customer_name]
    );
    const orderId = orderRes.insertId;
    for (const it of items) {
      await conn.execute(
        'INSERT INTO order_items (order_id,product_id,quantity,price) VALUES (?,?,?,?)',
        [orderId, it.product_id, it.quantity, it.price]
      );
      // ลด stock
      await conn.execute(
        'UPDATE products SET stock = stock - ? WHERE id = ?',
        [it.quantity, it.product_id]
      );
    }
    await conn.commit();
    res.json({ orderId });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// — ดูประวัติการสั่งซื้อ
app.get('/api/orders', async (req, res) => {
  const [orders] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  for (const o of orders) {
    const [items] = await pool.query(
      'SELECT oi.*, p.name FROM order_items oi JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?',
      [o.id]
    );
    o.items = items;
  }
  res.json(orders);
});


app.listen(process.env.PORT || 3000, () => console.log('Server running 3000'));
