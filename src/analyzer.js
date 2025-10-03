const { Client } = require('pg');
const nodemailer = require('nodemailer');

async function analyze() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: keywords } = await client.query(`
    SELECT DISTINCT source, category as keyword FROM products WHERE category IS NOT NULL
  `);

  for (const { source, keyword } of keywords) {
    const { rows } = await client.query(`
      SELECT * FROM products
      WHERE source = $1 AND category = $2 AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
    `, [source, keyword]);

    if (rows.length < 5) continue;

    const prices = rows.map(p => p.price).filter(p => p > 0);
    const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    const bargains = rows.filter(p =>
      p.status === '販売中' && p.price < avgPrice * 0.8 && p.price > 1000
    );

    for (const b of bargains) {
      const { rows: notified } = await client.query(`
        SELECT id FROM notification_log
        WHERE source = $1 AND product_id = $2 AND notified_at > NOW() - INTERVAL '24 hours'
      `, [source, b.product_id]);

      if (notified.length === 0 && process.env.EMAIL_USER) {
        const discount = Math.round((1 - b.price / avgPrice) * 100);
        await sendEmail(source, keyword, b, avgPrice, discount);

        await client.query(`
          INSERT INTO notification_log (source, product_id, title, price, discount_percent)
          VALUES ($1, $2, $3, $4, $5)
        `, [source, b.product_id, b.title, b.price, discount]);
      }
    }
  }

  await client.end();
}

async function sendEmail(source, keyword, product, avgPrice, discount) {
  const sourceName = source === 'mercari' ? 'メルカリ' : 'ヤフーフリマ';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });

  const subject = `🔥 お買い得発見！${sourceName} - ${discount}% OFF`;
  const html = `
    <h2>お買い得商品が見つかりました！</h2>
    <p><strong>サイト:</strong> ${sourceName}</p>
    <p><strong>カテゴリ:</strong> ${keyword}</p>
    <p><strong>商品:</strong> ${product.title}</p>
    <p><strong>価格:</strong> ¥${product.price.toLocaleString()}</p>
    <p><strong>平均価格:</strong> ¥${avgPrice.toLocaleString()}</p>
    <p><strong>割引率:</strong> ${discount}% OFF</p>
    <p><a href="${product.url}">商品を見る</a></p>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO,
      subject,
      html
    });
    console.log(`[${source}] メール送信: ${product.title}`);
  } catch (e) {
    console.error(`メール送信エラー: ${e.message}`);
  }
}

analyze().catch(console.error);
