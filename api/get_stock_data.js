// VercelのNode.jsランタイムで動作するサーバーレス関数

// 銘柄検索のロジック
async function handleSearch(query) {
    if (!query || query.trim().length < 2) {
        return [];
    }
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=ja-JP&region=JP`;
    const response = await fetch(url);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (!data.quotes || data.quotes.length === 0) {
        return [];
    }
    
    return data.quotes
        .filter(q => q.isYahooFinance && (q.quoteType === 'EQUITY' || q.quoteType === 'ETF'))
        .map(q => ({
            ticker: q.symbol,
            name: q.shortname || q.longname || q.symbol,
            exchange: q.exchangeDisp || q.exchange || ''
        }))
        .slice(0, 7);
}

// ポートフォリオ計算のロジック
async function handlePortfolio(portfolio, endDateStr) {
    const minDateStr = portfolio.reduce((min, p) => p.purchaseDate < min ? p.purchaseDate : min, endDateStr);
    const uniqueTickers = new Set(portfolio.map(p => p.ticker));
    if (portfolio.some(p => !p.ticker.endsWith('.T'))) {
        uniqueTickers.add('JPY=X');
    }

    const allData = {};
    for (const ticker of uniqueTickers) {
        allData[ticker] = await fetchHistoricalData(ticker, minDateStr, endDateStr);
    }
    
    const usdJpyRates = allData['JPY=X'] || {};
    let totalInitialInvestment = 0;
    for (const asset of portfolio) {
        const purchasePrice = findPriceOnDate(allData[asset.ticker], asset.purchaseDate, minDateStr);
        let investment = purchasePrice * asset.quantity;
        if (!asset.ticker.endsWith('.T')) {
            const exchangeRate = findPriceOnDate(usdJpyRates, asset.purchaseDate, minDateStr);
            investment *= exchangeRate;
        }
        totalInitialInvestment += investment;
    }

    const combinedData = {};
    const dateCursor = new Date(minDateStr);
    const finalDate = new Date(endDateStr);
    let lastPrices = {};
    let lastUsdJpyRate = 1.0;
    
    try {
        lastUsdJpyRate = findPriceOnDate(usdJpyRates, minDateStr, minDateStr);
    } catch (e) {
        const firstRateDate = Object.keys(usdJpyRates).sort()[0];
        if (firstRateDate) {
            lastUsdJpyRate = usdJpyRates[firstRateDate];
        } else if (portfolio.some(a => !a.ticker.endsWith('.T'))) {
            throw new Error("USD/JPYの為替レートデータが取得できませんでした。");
        }
    }

    while (dateCursor <= finalDate) {
        const currentDateStr = dateCursor.toISOString().split('T')[0];
        if (usdJpyRates[currentDateStr]) lastUsdJpyRate = usdJpyRates[currentDateStr];
        uniqueTickers.forEach(ticker => {
            if (allData[ticker] && allData[ticker][currentDateStr]) lastPrices[ticker] = allData[ticker][currentDateStr];
        });

        let dailyTotalValue = 0;
        if (portfolio.some(a => currentDateStr >= a.purchaseDate)) {
            for (const asset of portfolio) {
                if (currentDateStr >= asset.purchaseDate) {
                    if (!lastPrices[asset.ticker]) {
                        try {
                           lastPrices[asset.ticker] = findPriceOnDate(allData[asset.ticker], currentDateStr, minDateStr);
                        } catch(e) { continue; }
                    }
                    let assetValue = lastPrices[asset.ticker] * asset.quantity;
                    if (!asset.ticker.endsWith('.T')) assetValue *= lastUsdJpyRate;
                    dailyTotalValue += assetValue;
                }
            }
            combinedData[currentDateStr] = dailyTotalValue;
        }
        dateCursor.setDate(dateCursor.getDate() + 1);
    }
    
    return { combinedData, totalInitialInvestment };
}

// 補助関数
async function fetchHistoricalData(ticker, startDate, endDate) {
    const startTimestamp = new Date(startDate + 'T00:00:00Z').getTime() / 1000;
    const endTimestamp = new Date(endDate + 'T23:59:59Z').getTime() / 1000;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${startTimestamp}&period2=${endTimestamp}&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Data fetch failed for ${ticker}`);
    const data = await response.json();
    if (!data.chart.result) throw new Error(`No data for ${ticker}`);
    const result = data.chart.result[0];
    const priceData = {};
    if (result.timestamp) {
        result.timestamp.forEach((ts, i) => {
            if (result.indicators.quote[0].close[i] !== null && result.indicators.quote[0].close[i] !== undefined) {
                priceData[new Date(ts * 1000).toISOString().split('T')[0]] = result.indicators.quote[0].close[i];
            }
        });
    }
    return priceData;
}
function findPriceOnDate(priceData, targetDateStr, minDateStr) {
    let price = priceData[targetDateStr];
    if (price) return price;
    let tempDate = new Date(targetDateStr);
    const minDate = new Date(minDateStr);
    while (!price && tempDate >= minDate) {
        tempDate.setDate(tempDate.getDate() - 1);
        price = priceData[tempDate.toISOString().split('T')[0]];
    }
    if (!price) throw new Error(`Price not found for ${targetDateStr}`);
    return price;
}

// Vercelの作法に合わせたメインのハンドラ関数
module.exports = async (request, response) => {
    const { method } = request;

    try {
        // GETリクエストは銘柄検索
        if (method === 'GET') {
            const { query } = request.query;
            if (!query) {
                return response.status(400).json({ error: 'Query parameter is required for search.' });
            }
            const data = await handleSearch(query);
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.status(200).json(data);
        }

        // POSTリクエストはポートフォリオ計算
        if (method === 'POST') {
            if (!request.body || !request.body.portfolio || !request.body.endDate) {
                return response.status(400).json({ error: 'Invalid request body. "portfolio" and "endDate" are required.' });
            }
            const { portfolio, endDate } = request.body;
            const data = await handlePortfolio(portfolio, endDate);
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.status(200).json(data);
        }

        // GET, POST以外は許可しないメソッドとしてエラーを返す
        response.setHeader('Allow', ['GET', 'POST']);
        return response.status(405).json({ error: `Method ${method} Not Allowed` });

    } catch (error) {
        console.error(error);
        return response.status(500).json({ error: error.message });
    }
};
