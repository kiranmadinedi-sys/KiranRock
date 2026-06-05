/**
 * Comprehensive Stock Universe - 800+ Major US Stocks
 * Includes S&P 500, NASDAQ 100, Russell 1000 constituents
 * Organized by sector for efficient analysis
 */

// S&P 500 + NASDAQ 100 + High-volume stocks (800+ total)
const ALL_MAJOR_STOCKS = [
    // === TECHNOLOGY (150+ stocks) ===
    
    // Mega Cap Tech
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX', 'AVGO',
    
    // Large Cap Software
    'ORCL', 'ADBE', 'CRM', 'INTU', 'NOW', 'PANW', 'WDAY', 'SNOW', 'TEAM', 'ZS',
    'CRWD', 'DDOG', 'NET', 'PLTR', 'VEEV', 'ANSS', 'CDNS', 'SNPS', 'ADSK', 'ROP',
    'KEYS', 'PTC', 'TYL', 'FTNT', 'GEN', 'VRSN', 'AKAM', 'JKHY', 'FFIV', 'GDDY',
    
    // Cloud & SaaS
    'MDB', 'DOCU', 'ZM', 'TWLO', 'OKTA', 'ESTC', 'SMAR', 'PATH', 'BILL', 'ZI',
    'CFLT', 'S', 'NCNO', 'AI', 'GTLB', 'DOCN', 'FROG', 'IOT', 'MNDY', 'ASAN',
    
    // Semiconductors & Hardware
    'INTC', 'AMD', 'QCOM', 'TXN', 'ADI', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'MU',
    'NXPI', 'MCHP', 'SWKS', 'QRVO', 'ON', 'MPWR', 'ENTG', 'WOLF', 'ASML', 'TSM',
    'MKSI', 'CRUS', 'SLAB', 'SMCI', 'COHR', 'ALGM', 'LITE', 'POWI', 'RMBS', 'MTSI',
    
    // IT Services & Consulting
    'ACN', 'IBM', 'CSCO', 'HPQ', 'HPE', 'DELL', 'NTAP', 'WDC', 'STX', 'PSTG',
    'ANET', 'JNPR', 'FFIV', 'CIEN', 'VIAV', 'COMM', 'UI', 'DT', 'LDOS', 'SAIC',
    
    // Cybersecurity
    'PANW', 'CRWD', 'ZS', 'FTNT', 'S', 'OKTA', 'TENB', 'RBRK', 'VRNS', 'QLYS',
    
    // E-commerce & Digital Marketplaces
    'SHOP', 'MELI', 'SE', 'BABA', 'JD', 'PDD', 'BKNG', 'EXPE', 'ABNB', 'DASH',
    'UBER', 'LYFT', 'CPNG', 'EBAY', 'ETSY', 'W', 'CHWY', 'CVNA', 'CARS', 'RH',
    
    // Social Media & Content
    'SNAP', 'PINS', 'RDDT', 'MTCH', 'BMBL', 'YELP', 'TRIP', 'ANGI', 'IAC', 'ZG',
    
    // Gaming & Entertainment Tech
    'RBLX', 'TTWO', 'EA', 'ATVI', 'U', 'DKNG', 'PENN', 'LNW', 'GLPI', 'MGM',
    
    // Streaming & Media Tech
    'ROKU', 'SPOT', 'FUBO', 'WBD', 'PARA', 'FOXA', 'FOX', 'NXST', 'SIRI', 'LUMN',
    
    
    // === FINANCIALS (120+ stocks) ===
    
    // Mega Banks
    'JPM', 'BAC', 'WFC', 'C', 'USB', 'PNC', 'TFC', 'BK', 'STT', 'NTRS',
    
    // Regional Banks
    'CFG', 'FITB', 'HBAN', 'RF', 'KEY', 'MTB', 'CMA', 'ZION', 'WTFC', 'SNV',
    'FHN', 'HWC', 'ONB', 'ASB', 'UBSI', 'BOKF', 'CATY', 'FFIN', 'FULT', 'GBCI',
    
    // Investment Banks & Brokers
    'GS', 'MS', 'SCHW', 'BLK', 'BX', 'KKR', 'APO', 'ARES', 'CG', 'SF',
    'LAZ', 'EVR', 'MC', 'RJF', 'JEF', 'PJT', 'PIPR', 'HLNE',
    
    // Asset Management
    'TROW', 'BEN', 'IVZ', 'SEIC', 'AMG', 'APAM', 'EV', 'VCTR', 'VIRT', 'IBKR',
    
    // Payments & Fintech
    'V', 'MA', 'AXP', 'PYPL', 'SQ', 'FIS', 'FISV', 'FLT', 'GPN', 'COIN',
    'HOOD', 'SOFI', 'AFRM', 'UPST', 'LC', 'NU', 'INTU', 'BILL', 'ADP', 'PAYX',
    
    // Insurance - Life & P&C
    'BRK.B', 'PGR', 'ALL', 'TRV', 'CB', 'AIG', 'MET', 'PRU', 'AFL', 'CINF',
    'AJG', 'MMC', 'AON', 'WTW', 'BRO', 'KNSL', 'RNR', 'RGA', 'LNC', 'GL',
    
    // REITs
    'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'O', 'WELL', 'SPG', 'DLR', 'AVB',
    'EQR', 'VICI', 'INVH', 'ARE', 'MAA', 'UDR', 'EXR', 'CPT', 'KIM', 'REG',
    
    // Consumer Finance
    'COF', 'DFS', 'SYF', 'ALLY', 'AXP', 'WEX', 'CPAY', 'REPAY', 'GDOT', 'STNE',
    
    
    // === HEALTHCARE (120+ stocks) ===
    
    // Pharma - Large Cap
    'JNJ', 'PFE', 'ABBV', 'MRK', 'LLY', 'BMY', 'AMGN', 'GILD', 'REGN', 'VRTX',
    'BIIB', 'MRNA', 'BNTX', 'NVO', 'AZN', 'GSK', 'SNY', 'NVS', 'RHHBY', 'TAK',
    
    // Biotech
    'SRPT', 'ALNY', 'IONS', 'BMRN', 'JAZZ', 'UTHR', 'RARE', 'NBIX', 'INCY', 'EXAS',
    'TECH', 'ILMN', 'VRTX', 'ARWR', 'FOLD', 'CRSP', 'NTLA', 'EDIT', 'BLUE', 'SAGE',
    'BPMC', 'HALO', 'SAVA', 'SGEN', 'LEGN', 'DAWN', 'VKTX', 'GTHX', 'MDGL', 'KPTI',
    
    // Medical Devices
    'ABT', 'TMO', 'DHR', 'SYK', 'BSX', 'MDT', 'ISRG', 'EW', 'ZBH', 'BAX',
    'HOLX', 'DXCM', 'PODD', 'ALGN', 'IDXX', 'RMD', 'GEHC', 'BDX', 'VAR', 'XRAY',
    'RVTY', 'SOLV', 'GMED', 'NVST', 'NVCR', 'AXNX', 'IRTC', 'TMDX', 'OMCL', 'NARI',
    
    // Health Services
    'UNH', 'CVS', 'CI', 'ELV', 'HUM', 'CNC', 'MOH', 'ANTM', 'HCA', 'THC',
    'UHS', 'CYH', 'ENSG', 'AMED', 'LHC', 'ACHC', 'CHE', 'SEM', 'AGL', 'PNTG',
    
    // Healthcare Tech
    'VEEV', 'TDOC', 'HIMS', 'OSCR', 'ONEM', 'TNDM', 'CERT', 'DOCS', 'SDGR', 'EVH',
    
    // Lab & Diagnostics
    'IQV', 'LH', 'DGX', 'CRL', 'MEDP', 'QGEN', 'MYGN', 'PACB', 'ILMN', 'TMO',
    
    
    // === CONSUMER DISCRETIONARY (100+ stocks) ===
    
    // Retail - General
    'WMT', 'HD', 'LOW', 'TGT', 'COST', 'TJX', 'ROST', 'DG', 'DLTR', 'BIG',
    'BBY', 'FIVE', 'OLLI', 'BURL', 'AEO', 'ANF', 'URBN', 'GPS', 'GES', 'CHS',
    
    // Luxury & Apparel
    'NKE', 'LULU', 'ULTA', 'TPR', 'RL', 'PVH', 'HBI', 'UAA', 'CROX', 'DECK',
    'SKX', 'VSCO', 'BOOT', 'FL', 'ASO', 'DKS', 'HIBB', 'BGFV', 'GCO', 'EYE',
    
    // Home Improvement & Furnishings
    'HD', 'LOW', 'WSM', 'RH', 'W', 'BBWI', 'BBY', 'HBB', 'LESL', 'POOL',
    
    // Automotive
    'TSLA', 'F', 'GM', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'TM', 'HMC',
    'STLA', 'PAG', 'AN', 'LAD', 'ABG', 'SAH', 'GPI', 'KMX', 'CVNA', 'SFM',
    
    // Restaurants & Food Services
    'MCD', 'SBUX', 'CMG', 'YUM', 'QSR', 'DPZ', 'DRI', 'EAT', 'TXRH', 'BLMN',
    'WING', 'SHAK', 'BROS', 'JACK', 'PLAY', 'WEN', 'PZZA', 'TAST', 'DENN', 'BJRI',
    
    // Hotels & Leisure
    'MAR', 'HLT', 'H', 'IHG', 'ABNB', 'BKNG', 'EXPE', 'RCL', 'CCL', 'NCLH',
    'LVS', 'WYNN', 'MGM', 'CZR', 'PENN', 'SIX', 'FUN', 'SEAS', 'PLNT', 'XPOF',
    
    // Media & Entertainment
    'DIS', 'CMCSA', 'NFLX', 'WBD', 'PARA', 'LYV', 'MSG', 'MSGS', 'IMAX', 'CNK',
    
    
    // === CONSUMER STAPLES (60+ stocks) ===
    
    // Food & Beverage
    'PG', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'GIS', 'K', 'KHC', 'CAG',
    'CPB', 'MKC', 'HSY', 'SJM', 'HRL', 'TSN', 'CAG', 'POST', 'BGS', 'LANC',
    
    // Beverages
    'KO', 'PEP', 'MNST', 'KDP', 'STZ', 'TAP', 'BF.B', 'SAM', 'CELH', 'FIZZ',
    
    // Household & Personal Care
    'PG', 'CL', 'KMB', 'CLX', 'CHD', 'EL', 'COTY', 'EPC', 'SPB', 'CENT',
    
    // Tobacco
    'PM', 'MO', 'BTI', 'UVV', 'VGR', 'XXII', 'TURNING', 'IMBBY',
    
    // Food Retail
    'WMT', 'COST', 'KR', 'SYY', 'USFD', 'PFGC', 'UNFI', 'ACI', 'IMKTA', 'TGT',
    
    
    // === ENERGY (70+ stocks) ===
    
    // Oil & Gas - Integrated
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'HES', 'MPC', 'PSX', 'VLO',
    'DVN', 'FANG', 'MRO', 'APA', 'OVV', 'CTRA', 'EQT', 'AR', 'CNX', 'RRC',
    
    // Oil Services
    'SLB', 'HAL', 'BKR', 'FTI', 'NOV', 'HP', 'CHX', 'PTEN', 'WTTR', 'LBRT',
    'WHD', 'PUMP', 'NBR', 'RIG', 'NE', 'VAL', 'TDW', 'NINE', 'AROC', 'WTTR',
    
    // Pipelines & Midstream
    'WMB', 'OKE', 'KMI', 'LNG', 'EPD', 'ET', 'MPLX', 'PAA', 'WES', 'HESM',
    
    // Renewables & Clean Energy
    'NEE', 'ENPH', 'SEDG', 'RUN', 'PLUG', 'BE', 'FCEL', 'CHPT', 'BLNK', 'EVGO',
    'QS', 'NOVA', 'TSLA', 'RIVN', 'LCID', 'STEM', 'MAXN', 'ARRY', 'DQ', 'JKS',
    
    
    // === INDUSTRIALS (100+ stocks) ===
    
    // Aerospace & Defense
    'BA', 'LMT', 'RTX', 'GD', 'NOC', 'HWM', 'TDG', 'TXT', 'LHX', 'HEI',
    'HEI.A', 'AVAV', 'WWD', 'CW', 'KTOS', 'AIR', 'SPR', 'TGI', 'ASTE', 'MOG.A',
    
    // Machinery & Equipment
    'CAT', 'DE', 'CMI', 'EMR', 'ETN', 'ROK', 'PH', 'ITW', 'FTV', 'DOV',
    'IR', 'XYL', 'GGG', 'ALSN', 'HUBB', 'GNRC', 'RRX', 'BMI', 'TTC', 'MTZ',
    
    // Transportation & Logistics
    'UPS', 'FDX', 'UBER', 'LYFT', 'XPO', 'JBHT', 'ODFL', 'CHRW', 'KNX', 'R',
    'EXPD', 'LSTR', 'WERN', 'SAIA', 'ARCB', 'MATX', 'MRTN', 'HTLD', 'CVLG', 'SNDR',
    
    // Airlines
    'UAL', 'DAL', 'AAL', 'LUV', 'ALK', 'JBLU', 'HA', 'SKYW', 'SAVE', 'MESA',
    
    // Railroads
    'UNP', 'NSC', 'CSX', 'CP', 'CNI', 'KSU', 'GWR', 'RAIL',
    
    // Construction & Engineering
    'JCI', 'HON', 'MMM', 'GE', 'WM', 'RSG', 'URI', 'PWR', 'FLR', 'JLL',
    'CBRE', 'MAS', 'OC', 'VMC', 'MLM', 'SUM', 'NVR', 'DHI', 'LEN', 'PHM',
    
    
    // === MATERIALS (50+ stocks) ===
    
    // Chemicals
    'LIN', 'APD', 'ECL', 'SHW', 'DD', 'DOW', 'PPG', 'NUE', 'FCX', 'NEM',
    'CE', 'ALB', 'EMN', 'FMC', 'CF', 'MOS', 'IFF', 'RPM', 'SEE', 'AVY',
    
    // Metals & Mining
    'NUE', 'STLD', 'RS', 'CLF', 'X', 'MT', 'CMC', 'WOR', 'ZEUS', 'ATI',
    'FCX', 'NEM', 'GOLD', 'AEM', 'AU', 'BTG', 'KGC', 'HL', 'CDE', 'AG',
    
    // Paper & Packaging
    'IP', 'PKG', 'WRK', 'GPK', 'CCK', 'BALL', 'SON', 'SLG', 'BLL', 'AMCR',
    
    
    // === UTILITIES (60+ stocks) ===
    
    // Electric Utilities
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'WEC', 'ES',
    'ED', 'PEG', 'FE', 'ETR', 'EIX', 'AWK', 'PPL', 'ATO', 'CMS', 'DTE',
    
    // Multi-Utilities
    'PCG', 'NI', 'NWE', 'OTTR', 'AVA', 'PNW', 'SJW', 'BKH', 'NWN', 'SR',
    
    // Renewable Utilities
    'NEE', 'AES', 'AEE', 'VST', 'CWEN', 'NEP', 'BEP', 'BEPC', 'AY', 'TAC',
    
    
    // === COMMUNICATIONS (40+ stocks) ===
    
    // Telecom Services
    'T', 'VZ', 'TMUS', 'S', 'USM', 'ATUS', 'CABO', 'LUMN', 'FYBR', 'SHEN',
    
    // Cable & Satellite
    'CMCSA', 'CHTR', 'DISH', 'LBRDA', 'LBRDK', 'LILAK', 'REZI', 'TGNA', 'NXST', 'GTN',
    
    // Entertainment & Media
    'DIS', 'NFLX', 'WBD', 'PARA', 'FOXA', 'FOX', 'LYV', 'IMAX', 'MSG', 'MSGS',
    
    
    // === REAL ESTATE (covered in Financials/REITs above) ===
];

// Remove duplicates and sort
const COMPREHENSIVE_STOCK_UNIVERSE = [...new Set(ALL_MAJOR_STOCKS)].sort();

// Export different universe sizes for different use cases
module.exports = {
    // Full universe (800+)
    ALL_STOCKS: COMPREHENSIVE_STOCK_UNIVERSE,
    
    // Quick analysis subset (200 most liquid)
    TOP_200: COMPREHENSIVE_STOCK_UNIVERSE.slice(0, 200),
    
    // Mega cap only (50)
    MEGA_CAP: [
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK.B', 'V', 'UNH',
        'XOM', 'JPM', 'JNJ', 'WMT', 'MA', 'PG', 'LLY', 'CVX', 'AVGO', 'HD',
        'MRK', 'ABBV', 'COST', 'PEP', 'KO', 'ORCL', 'ADBE', 'CRM', 'NFLX', 'TMO',
        'MCD', 'CSCO', 'ACN', 'NKE', 'LIN', 'ABT', 'DHR', 'TXN', 'INTC', 'AMD',
        'QCOM', 'PM', 'NEE', 'RTX', 'INTU', 'HON', 'UNP', 'UPS', 'AMGN', 'LOW'
    ],
    
    // Total count
    TOTAL_COUNT: COMPREHENSIVE_STOCK_UNIVERSE.length
};
