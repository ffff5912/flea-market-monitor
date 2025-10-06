const { Client } = require('pg');

async function cleanup() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  await client.connect();
  
  // 90日以上前のデータを削除
  const { rowCount } = await client.query(`
    DELETE FROM products
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);
  
  console.log(`[クリーンアップ] ${rowCount}件削除`);
  
  await client.end();
}

cleanup().catch(console.error);
