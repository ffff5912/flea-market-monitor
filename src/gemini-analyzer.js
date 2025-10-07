const { GoogleGenAI } = require('@google/genai');
const { Client } = require('pg');

async function geminiAnalyze() {
  console.log('[Gemini分析] 開始...');
  
  if (!process.env.GEMINI_API_KEY) {
    console.error('[エラー] GEMINI_API_KEYが設定されていません');
    return;
  }
  
  const dbClient = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    await dbClient.connect();
    console.log('[DB] 接続成功');
    
    const days = process.env.ANALYSIS_DAYS || 7;
    const { rows } = await dbClient.query(`
      SELECT 
        category, status, price, title,
        EXTRACT(EPOCH FROM (sold_at - created_at))/3600 as hours_to_sell,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created_at
      FROM products
      WHERE created_at > NOW() - INTERVAL '${days} days'
      ORDER BY created_at DESC
    `);
    
    await dbClient.end();
    console.log(`[DB] ${rows.length}件のデータ取得`);
    
    if (rows.length === 0) {
      console.log('[警告] データが0件');
      return;
    }
    
    const summary = {
      total_items: rows.length,
      sold_items: rows.filter(r => r.status === 'SOLD').length,
      on_sale_items: rows.filter(r => r.status === '販売中').length,
      categories: [...new Set(rows.map(r => r.category))].slice(0, 50)
    };
    
    console.log('[統計] 合計:', summary.total_items);
    console.log('[統計] SOLD:', summary.sold_items);
    console.log('[統計] 販売中:', summary.on_sale_items);
    
    if (!process.env.GEMINI_PROMPT) {
      console.error('[エラー] GEMINI_PROMPTが設定されていません');
      return;
    }
    
    // データを400件ずつのチャンクに分割（約10万トークン/チャンク）
    const chunkSize = 400;
    const chunks = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      chunks.push(rows.slice(i, i + chunkSize));
    }
    
    console.log(`[分割] ${chunks.length}チャンクに分割`);
    
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    let combinedAnalysis = '';
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkData = chunks[i];
      
      // プロンプトのテンプレート変数を置換
      const prompt = process.env.GEMINI_PROMPT
        .replace(/{{total_items}}/g, summary.total_items)
        .replace(/{{sold_items}}/g, summary.sold_items)
        .replace(/{{on_sale_items}}/g, summary.on_sale_items)
        .replace(/{{categories_count}}/g, summary.categories.length)
        .replace(/{{categories}}/g, summary.categories.join(', '))
        .replace(/{{sample_data}}/g, JSON.stringify(chunkData, null, 2))
        .replace(/{{sample_size}}/g, chunkData.length)
        // チャンク情報を追加
        + `\n\n【注意】これは全${summary.total_items}件中の${i * chunkSize + 1}件目から${Math.min((i + 1) * chunkSize, summary.total_items)}件目までのデータです（チャンク${i + 1}/${chunks.length}）。`;
      
      console.log(`[Gemini] チャンク ${i + 1}/${chunks.length} 送信中... (${chunkData.length}件)`);
      const startTime = Date.now();
      
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash-exp',
          contents: prompt,
        });
        
        const text = response.text;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Gemini] チャンク ${i + 1} 完了（${elapsed}秒）`);
        
        combinedAnalysis += `\n\n## チャンク ${i + 1}/${chunks.length} の分析結果\n\n${text}\n\n---\n`;
        
        // 最後のチャンク以外は60秒待機（レート制限回避）
        if (i < chunks.length - 1) {
          console.log('[待機] 60秒待機中...');
          await new Promise(resolve => setTimeout(resolve, 60000));
        }
      } catch (error) {
        console.error(`[エラー] チャンク ${i + 1} でエラー:`, error.message);
        
        // リトライ（1回のみ）
        if (error.message.includes('429')) {
          console.log('[リトライ] 90秒待機後に再試行...');
          await new Promise(resolve => setTimeout(resolve, 90000));
          
          const retryResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash-exp',
            contents: prompt,
          });
          
          combinedAnalysis += `\n\n## チャンク ${i + 1}/${chunks.length} の分析結果\n\n${retryResponse.text}\n\n---\n`;
        } else {
          throw error;
        }
      }
    }
    
    // 最終統合レポート作成
    console.log('[Gemini] 最終統合レポート作成中...');
    const summaryPrompt = `以下は${chunks.length}回に分けて分析した結果です。これらを統合して、1つの包括的な分析レポートにまとめてください。

【統合指示】
- 重複する情報は統合してください
- 矛盾する情報があれば調整してください
- 最終的な売れ筋TOP10、仕入れ推奨商品、避けるべき商品をまとめてください
- マークダウン形式で見やすく整形してください

【分析結果】
${combinedAnalysis}`;
    
    const finalResponse = await ai.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: summaryPrompt,
    });
    
    const finalText = finalResponse.text;
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 Gemini分析レポート（統合版）');
    console.log('='.repeat(80) + '\n');
    console.log(finalText);
    console.log('\n' + '='.repeat(80));
    
    const fs = require('fs');
    const date = new Date().toISOString().split('T')[0];
    const filename = `analysis-${date}.md`;
    fs.writeFileSync(filename, `# メルカリ分析レポート - ${date}\n\n${finalText}`);
    console.log(`\n[保存] ${filename}`);
    
  } catch (error) {
    console.error('[エラー]', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

geminiAnalyze().then(() => {
  console.log('\n✅ 完了');
  process.exit(0);
}).catch(error => {
  console.error('❌ エラー:', error);
  process.exit(1);
});
