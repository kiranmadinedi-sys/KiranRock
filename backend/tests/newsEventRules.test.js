/** News event rules + Gemini reply parsing (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { classifyRule, parseGeminiReply } = require('../src/services/newsEventService');

test.each([
    ['Citigroup Upgrades Nu Holdings to Buy, Raises Price Target to $18', 'analyst_upgrade'],
    ['Mizuho Maintains Outperform on ON Semiconductor, Lowers Price Target to $70', 'pt_lower'],
    ['Stifel Maintains Buy on BellRing Brands, Raises Price Target to $67', 'pt_raise'],
    ['Deutsche Bank Adjusts Centene Price Target to $87 From $85', 'noise'],
    ['Stride Q4 EPS $2.29 Beats $1.74 Estimate, Sales $653.65M Beat $626.27M Estimate', 'earnings_beat'],
    ['Peraso Q2 Adj. EPS $(0.28) Beats $(0.46) Estimate, Sales $2.20M Miss $2.68M Estimate', 'earnings_mixed'],
    ['Middleby Raises FY2026 Adj EPS Guidance from $9.20-$9.36 to $9.54-$9.70 vs $9.30 Est', 'guidance_raise'],
    ['First Solar Reports Q3 2026 Results and Lowers Full-Year Guidance', 'guidance_cut'],
    ['Bristol-Myers Squibb Lowers FY2026 Adj EPS Guidance; Raises Sales Guidance', 'unclassified'],
    ['Elong Power Holding Prices Registered Offering Of 16.5M Units At $0.40 Per Unit', 'offering'],
    ['NLS Pharmaceutics Plans To Effect A Reverse Share Split At 1-for-10', 'reverse_split'],
    ['Tetra Tech Wins $39M USAID Contract To Increase Gender Equality', 'contract_win'],
    ['CIBC Global Asset Management Receives Four 2026 Canada LSEG Lipper Fund Awards', 'unclassified'],
    ['Incyte Announces FDA Approval Of Zynyz For The Treatment Of Metastatic Cancer', 'fda_approval'],
    ['Spotlight on Spotify Technology: Analyzing the Surge in Options Activity', 'noise'],
    ['Why Roadzen (RDZN) Stock Is Trading Lower', 'noise'],
    ['SolarEdge To Acquire Hark Systems; Terms Not Disclosed', 'unclassified'],
])('%s → %s', (headline, type) => expect(classifyRule(headline)).toBe(type));

test('parseGeminiReply keeps only valid indexes and known types', () => {
    const reply = JSON.stringify([{ i: 0, t: 'acquirer' }, { i: 1, t: 'made_up' }, { i: 9, t: 'noise' }, { i: 2, t: 'noise' }]);
    expect(parseGeminiReply(reply, 3)).toEqual([{ i: 0, t: 'acquirer' }, { i: 2, t: 'noise' }]);
    expect(parseGeminiReply('not json', 3)).toEqual([]);
    expect(parseGeminiReply('```json\n[{"i":0,"t":"buyback"}]\n```', 1)).toEqual([{ i: 0, t: 'buyback' }]);
});
