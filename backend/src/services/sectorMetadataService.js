/**
 * Sector Metadata Service — Static fallback sector map
 *
 * Yahoo Finance frequently returns null/empty sector for velocity stocks,
 * recent IPOs, and tickers outside the core S&P 500. When that happens the
 * whole sector-rotation, regime-awareness, and correlation-management layer
 * goes blind because everything falls into "Unknown".
 *
 * This service provides a static fallback lookup so the bot always has a
 * sector even when Yahoo doesn't return one. GICS sector names match the
 * strings Yahoo returns (so the SECTOR_TRADE_PROFILES in the bot apply correctly).
 *
 * Priority of sector resolution (in analyzeStockWithAI):
 *   1. Yahoo quote.sector  — live, most accurate
 *   2. This static map     — covers ~400 common S&P500 / NASDAQ 100 / Russell 1000 names
 *   3. 'Unknown'           — fallback (STANDARD trade profile, no rotation logic)
 */

const SECTOR_MAP = {
    // ── Technology ────────────────────────────────────────────────────────────
    AAPL:'Technology', MSFT:'Technology', NVDA:'Technology', AMD:'Technology',
    INTC:'Technology', QCOM:'Technology', AVGO:'Technology', ADBE:'Technology',
    CRM:'Technology',  NOW:'Technology',  ORCL:'Technology', IBM:'Technology',
    TXN:'Technology',  ADI:'Technology',  MU:'Technology',   AMAT:'Technology',
    LRCX:'Technology', KLAC:'Technology', SNPS:'Technology', CDNS:'Technology',
    FTNT:'Technology', PANW:'Technology', CRWD:'Technology', ZS:'Technology',
    DDOG:'Technology', SNOW:'Technology', PLTR:'Technology', NET:'Technology',
    MDB:'Technology',  TEAM:'Technology', HUBS:'Technology', WDAY:'Technology',
    INTU:'Technology', ANSS:'Technology', ENPH:'Technology', ROP:'Technology',
    MPWR:'Technology', MCHP:'Technology', SWKS:'Technology', QRVO:'Technology',
    SMCI:'Technology', ARM:'Technology',  ALAB:'Technology', AEHR:'Technology',
    ONTO:'Technology', FORM:'Technology', COHU:'Technology', UCTT:'Technology',
    ACN:'Technology',  CTSH:'Technology', EPAM:'Technology', GLOB:'Technology',
    IT:'Technology',   GWRE:'Technology', PCTY:'Technology', PAYC:'Technology',
    PEGA:'Technology', MANH:'Technology', TYL:'Technology',  MSCI:'Technology',
    VRSK:'Technology', FDS:'Technology',  NUAN:'Technology', JNPR:'Technology',

    // ── Communication Services ────────────────────────────────────────────────
    META:'Communication Services', GOOGL:'Communication Services',
    GOOG:'Communication Services', DIS:'Communication Services',
    NFLX:'Communication Services', CMCSA:'Communication Services',
    T:'Communication Services',    VZ:'Communication Services',
    TMUS:'Communication Services', CHTR:'Communication Services',
    WBD:'Communication Services',  PARA:'Communication Services',
    NWSA:'Communication Services', NWS:'Communication Services',
    FOXA:'Communication Services', FOX:'Communication Services',
    TTWO:'Communication Services', EA:'Communication Services',
    ATVI:'Communication Services', RBLX:'Communication Services',
    SNAP:'Communication Services', PINS:'Communication Services',
    MTCH:'Communication Services', IAC:'Communication Services',
    ZM:'Communication Services',   TWLO:'Communication Services',
    LUMN:'Communication Services', OMC:'Communication Services',
    IPG:'Communication Services',

    // ── Consumer Discretionary ────────────────────────────────────────────────
    AMZN:'Consumer Discretionary', TSLA:'Consumer Discretionary',
    HD:'Consumer Discretionary',   LOW:'Consumer Discretionary',
    TGT:'Consumer Discretionary',  SBUX:'Consumer Discretionary',
    MCD:'Consumer Discretionary',  NKE:'Consumer Discretionary',
    BKNG:'Consumer Discretionary', MAR:'Consumer Discretionary',
    HLT:'Consumer Discretionary',  RCL:'Consumer Discretionary',
    CCL:'Consumer Discretionary',  NCLH:'Consumer Discretionary',
    LVS:'Consumer Discretionary',  MGM:'Consumer Discretionary',
    WYNN:'Consumer Discretionary', F:'Consumer Discretionary',
    GM:'Consumer Discretionary',   RIVN:'Consumer Discretionary',
    LCID:'Consumer Discretionary', NIO:'Consumer Discretionary',
    XPEV:'Consumer Discretionary', LI:'Consumer Discretionary',
    // International auto ADRs — Yahoo often returns no sector for these
    HMC:'Consumer Discretionary',  TM:'Consumer Discretionary',
    STLA:'Consumer Discretionary', HMC:'Consumer Discretionary',
    RACE:'Consumer Discretionary', BMWYY:'Consumer Discretionary',
    DKNG:'Consumer Discretionary', PENN:'Consumer Discretionary',
    DHI:'Consumer Discretionary',  LEN:'Consumer Discretionary',
    PHM:'Consumer Discretionary',  TOL:'Consumer Discretionary',
    NVR:'Consumer Discretionary',  POOL:'Consumer Discretionary',
    ROST:'Consumer Discretionary', TJX:'Consumer Discretionary',
    BBY:'Consumer Discretionary',  GPS:'Consumer Discretionary',
    TPR:'Consumer Discretionary',  VFC:'Consumer Discretionary',
    PVH:'Consumer Discretionary',  HAS:'Consumer Discretionary',
    MAT:'Consumer Discretionary',  ETSY:'Consumer Discretionary',
    ABNB:'Consumer Discretionary', UBER:'Consumer Discretionary',
    LYFT:'Consumer Discretionary', DASH:'Consumer Discretionary',
    W:'Consumer Discretionary',    OSTK:'Consumer Discretionary',
    RH:'Consumer Discretionary',   WSM:'Consumer Discretionary',
    WING:'Consumer Discretionary', DRI:'Consumer Discretionary',
    YUM:'Consumer Discretionary',  QSR:'Consumer Discretionary',
    CMG:'Consumer Discretionary',  SHAK:'Consumer Discretionary',
    CAKE:'Consumer Discretionary', TXRH:'Consumer Discretionary',
    CBRL:'Consumer Discretionary',

    // ── Consumer Staples ──────────────────────────────────────────────────────
    WMT:'Consumer Staples', KO:'Consumer Staples',   PEP:'Consumer Staples',
    PG:'Consumer Staples',  COST:'Consumer Staples', CL:'Consumer Staples',
    KMB:'Consumer Staples', MO:'Consumer Staples',   PM:'Consumer Staples',
    BTI:'Consumer Staples', MDLZ:'Consumer Staples', GIS:'Consumer Staples',
    K:'Consumer Staples',   CPB:'Consumer Staples',  CAG:'Consumer Staples',
    HRL:'Consumer Staples', TSN:'Consumer Staples',  SJM:'Consumer Staples',
    MKC:'Consumer Staples', TAP:'Consumer Staples',  STZ:'Consumer Staples',
    SAM:'Consumer Staples', BUD:'Consumer Staples',  DEO:'Consumer Staples',
    EL:'Consumer Staples',  CHD:'Consumer Staples',  CLX:'Consumer Staples',
    SYY:'Consumer Staples', USFD:'Consumer Staples', KR:'Consumer Staples',
    ACI:'Consumer Staples', WBA:'Consumer Staples',  CVS:'Consumer Staples',
    DRVN:'Consumer Staples',

    // ── Healthcare ────────────────────────────────────────────────────────────
    JNJ:'Healthcare',  UNH:'Healthcare', LLY:'Healthcare',  ABT:'Healthcare',
    ABBV:'Healthcare', AMGN:'Healthcare',GILD:'Healthcare', MDT:'Healthcare',
    BMY:'Healthcare',  PFE:'Healthcare', MRK:'Healthcare',  TMO:'Healthcare',
    DHR:'Healthcare',  ISRG:'Healthcare',SYK:'Healthcare',  ZTS:'Healthcare',
    EW:'Healthcare',   BDX:'Healthcare', BAX:'Healthcare',  BSX:'Healthcare',
    IQV:'Healthcare',  IQVIA:'Healthcare',CNC:'Healthcare', HCA:'Healthcare',
    HUM:'Healthcare',  ELV:'Healthcare', CI:'Healthcare',   MOH:'Healthcare',
    BIIB:'Healthcare', VRTX:'Healthcare',REGN:'Healthcare', ILMN:'Healthcare',
    MRNA:'Healthcare', BNTX:'Healthcare',NVAX:'Healthcare', SRPT:'Healthcare',
    ALNY:'Healthcare', INCY:'Healthcare',EXAS:'Healthcare', VEEV:'Healthcare',
    IDXX:'Healthcare', PODD:'Healthcare',DXCM:'Healthcare', HOLX:'Healthcare',
    MTD:'Healthcare',  WST:'Healthcare', TECH:'Healthcare', RMD:'Healthcare',
    GEHC:'Healthcare', SOLV:'Healthcare',

    // ── Financials ────────────────────────────────────────────────────────────
    JPM:'Financials', BAC:'Financials', WFC:'Financials', C:'Financials',
    GS:'Financials',  MS:'Financials',  BLK:'Financials', SCHW:'Financials',
    USB:'Financials', PNC:'Financials', TFC:'Financials', COF:'Financials',
    AXP:'Financials', DFS:'Financials', SYF:'Financials', ALLY:'Financials',
    BK:'Financials',  STT:'Financials', RF:'Financials',  HBAN:'Financials',
    CFG:'Financials', KEY:'Financials', FITB:'Financials', MTB:'Financials',
    ZION:'Financials',CMA:'Financials', FNB:'Financials',  WTFC:'Financials',
    FHN:'Financials', SNV:'Financials', EWBC:'Financials',
    MCO:'Financials', SPGI:'Financials',ICE:'Financials',  CBOE:'Financials',
    CME:'Financials', NDAQ:'Financials',MSCI:'Financials',
    CB:'Financials',  AIG:'Financials', AFL:'Financials',  ALL:'Financials',
    TRV:'Financials', HIG:'Financials', MET:'Financials',  PRU:'Financials',
    LNC:'Financials', UNM:'Financials', GL:'Financials',   RLI:'Financials',
    PGR:'Financials', CINF:'Financials',MMC:'Financials',  AON:'Financials',
    WTW:'Financials', MKL:'Financials',
    V:'Financials',   MA:'Financials',  PYPL:'Financials', FIS:'Financials',
    FISV:'Financials',GPN:'Financials', WU:'Financials',   SQ:'Financials',
    AFRM:'Financials',SOFI:'Financials',NU:'Financials',   HOOD:'Financials',
    COIN:'Financials', MKTX:'Financials',RJF:'Financials', SSNC:'Financials',
    FDS:'Financials', DNB:'Financials',

    // ── Energy ────────────────────────────────────────────────────────────────
    XOM:'Energy',  CVX:'Energy', COP:'Energy', OXY:'Energy', HAL:'Energy',
    SLB:'Energy',  BKR:'Energy', MPC:'Energy', PSX:'Energy', VLO:'Energy',
    HES:'Energy',  DVN:'Energy', FANG:'Energy',EOG:'Energy', PXD:'Energy',
    APA:'Energy',  MRO:'Energy', KMI:'Energy', WMB:'Energy', ET:'Energy',
    EPD:'Energy',  MPLX:'Energy',PAA:'Energy', TRGP:'Energy',
    RIG:'Energy',  VAL:'Energy', HP:'Energy',  DO:'Energy',  NE:'Energy',
    NOV:'Energy',  WTTR:'Energy',ACDC:'Energy',

    // ── Industrials ───────────────────────────────────────────────────────────
    CAT:'Industrials', DE:'Industrials',  HON:'Industrials', EMR:'Industrials',
    GE:'Industrials',  RTX:'Industrials', LMT:'Industrials', NOC:'Industrials',
    BA:'Industrials',  GD:'Industrials',  LHX:'Industrials', HII:'Industrials',
    TDG:'Industrials', HWM:'Industrials', HEICO:'Industrials',
    UNP:'Industrials', NSC:'Industrials', CSX:'Industrials', KSU:'Industrials',
    CHRW:'Industrials',XPO:'Industrials', RXO:'Industrials', SAIA:'Industrials',
    ODFL:'Industrials',WERN:'Industrials',LSTR:'Industrials',
    // Trucking / Logistics (specifically flagged in ChatGPT report)
    SNDR:'Industrials', CVLG:'Industrials', HTLD:'Industrials',
    KNX:'Industrials',  JBHT:'Industrials', MRTN:'Industrials',
    ARCB:'Industrials', USX:'Industrials',  DCOM:'Industrials',
    UPS:'Industrials',  FDX:'Industrials',  AMBC:'Industrials',
    PCAR:'Industrials', CMI:'Industrials',  ALSN:'Industrials',
    AGCO:'Industrials', WCN:'Industrials',  RSG:'Industrials',
    WM:'Industrials',   CLH:'Industrials',  CTAS:'Industrials',
    ROL:'Industrials',  SIC:'Industrials',
    ITW:'Industrials',  DOV:'Industrials',  ETN:'Industrials',
    PH:'Industrials',   ROP:'Industrials',  IEX:'Industrials',
    GNRC:'Industrials', NDSN:'Industrials', SWK:'Industrials',
    SNA:'Industrials',  MSA:'Industrials',  ACCO:'Industrials',
    AOS:'Industrials',  CARR:'Industrials', OTIS:'Industrials',
    TT:'Industrials',   JCI:'Industrials',  LII:'Industrials',
    AEIS:'Industrials', AME:'Industrials',  HUBB:'Industrials',
    PWR:'Industrials',  DAL:'Industrials',  UAL:'Industrials',
    AAL:'Industrials',  LUV:'Industrials',  ALGT:'Industrials',
    ULCC:'Industrials', ALK:'Industrials',  SAVE:'Industrials',
    JBLU:'Industrials', MESA:'Industrials', SKYW:'Industrials',
    RHI:'Industrials',  MAN:'Industrials',  KELYA:'Industrials',
    KFRC:'Industrials', TBI:'Industrials',

    // ── Materials ─────────────────────────────────────────────────────────────
    LIN:'Materials',  APD:'Materials',  NEM:'Materials',  FCX:'Materials',
    NUE:'Materials',  STLD:'Materials', CLF:'Materials',  X:'Materials',
    AA:'Materials',   CENX:'Materials', WLK:'Materials',  LYB:'Materials',
    DOW:'Materials',  DD:'Materials',   EMN:'Materials',  CE:'Materials',
    HUN:'Materials',  RPM:'Materials',  SHW:'Materials',  PPG:'Materials',
    ECL:'Materials',  FMC:'Materials',  MOS:'Materials',  CF:'Materials',
    AVY:'Materials',  IP:'Materials',   SEE:'Materials',  PKG:'Materials',
    WRK:'Materials',  GPK:'Materials',  SLVM:'Materials',
    MLM:'Materials',  VMC:'Materials',  SUM:'Materials',  CRH:'Materials',
    RGLD:'Materials', WPM:'Materials',  GOLD:'Materials', KGC:'Materials',
    AEM:'Materials',  PAAS:'Materials', PVG:'Materials',

    // ── Real Estate ───────────────────────────────────────────────────────────
    PLD:'Real Estate',  AMT:'Real Estate',  WELL:'Real Estate',
    DLR:'Real Estate',  SPG:'Real Estate',  O:'Real Estate',
    VICI:'Real Estate', CCI:'Real Estate',  EQIX:'Real Estate',
    EXR:'Real Estate',  PSA:'Real Estate',  AVB:'Real Estate',
    EQR:'Real Estate',  ESS:'Real Estate',  UDR:'Real Estate',
    ARE:'Real Estate',  BXP:'Real Estate',  KIM:'Real Estate',
    REG:'Real Estate',  FRT:'Real Estate',  SLG:'Real Estate',
    VNO:'Real Estate',  WPC:'Real Estate',  NNN:'Real Estate',
    COLD:'Real Estate', IIPR:'Real Estate', MPW:'Real Estate',
    PEAK:'Real Estate', HST:'Real Estate',  ROIC:'Real Estate',

    // ── Utilities ─────────────────────────────────────────────────────────────
    NEE:'Utilities', DUK:'Utilities', SO:'Utilities',  AEP:'Utilities',
    D:'Utilities',   EXC:'Utilities', SRE:'Utilities', PCG:'Utilities',
    XEL:'Utilities', ED:'Utilities',  DTE:'Utilities', ES:'Utilities',
    FE:'Utilities',  AEE:'Utilities', ATO:'Utilities', NI:'Utilities',
    CMS:'Utilities', PPL:'Utilities', PNW:'Utilities', WEC:'Utilities',
    ETR:'Utilities', CNP:'Utilities', NRG:'Utilities', AES:'Utilities',
    LNT:'Utilities', EVRG:'Utilities',IDA:'Utilities', OGE:'Utilities',
    NWE:'Utilities', BKH:'Utilities', POR:'Utilities', SWX:'Utilities',
    AWK:'Utilities', WTRG:'Utilities',AWR:'Utilities', ARTNA:'Utilities',
    SJW:'Utilities', MSEX:'Utilities',

    // ── Technology (additional) ───────────────────────────────────────────────
    CSCO:'Technology',  DELL:'Technology',  HPE:'Technology',   HPQ:'Technology',
    STX:'Technology',   WDC:'Technology',   NTAP:'Technology',  GLW:'Technology',
    JNPR:'Technology',  MSI:'Technology',   IPGP:'Technology',  DIOD:'Technology',
    KEYS:'Technology',  TER:'Technology',   MKSI:'Technology',  ENTG:'Technology',
    ALGM:'Technology',  LSCC:'Technology',  NXPI:'Technology',  AMBA:'Technology',
    SLAB:'Technology',  SITM:'Technology',  CEVA:'Technology',  PI:'Technology',
    WOLF:'Technology',  ON:'Technology',
    ADP:'Technology',   ADSK:'Technology',  PAYX:'Technology',  ANSS:'Technology',
    ALTR:'Technology',  AKAM:'Technology',  VRSN:'Technology',  GDDY:'Technology',
    OKTA:'Technology',  BRZE:'Technology',  NCNO:'Technology',  CFLT:'Technology',
    DOMO:'Technology',  DOCN:'Technology',  ESTC:'Technology',  APPN:'Technology',
    JAMF:'Technology',  WK:'Technology',    ZUO:'Technology',   ZI:'Technology',
    SPT:'Technology',   SMAR:'Technology',  PCOR:'Technology',  IOT:'Technology',
    TOST:'Technology',  PAR:'Technology',   TTD:'Technology',   BILL:'Technology',
    PTC:'Technology',   TRMB:'Technology',  FI:'Technology',    KD:'Technology',
    PSTG:'Technology',  NTNX:'Technology',  CWAN:'Technology',  RDWR:'Technology',
    LIDR:'Technology',  TASK:'Technology',  GTLB:'Technology',  APP:'Technology',
    MRVL:'Technology',  ASML:'Technology',  ACLS:'Technology',  ACMR:'Technology',
    SEDG:'Technology',  ARRY:'Technology',  ZG:'Real Estate',

    // ── Consumer Discretionary (additional) ──────────────────────────────────
    AZN:'Healthcare',
    LULU:'Consumer Discretionary', AZO:'Consumer Discretionary',
    ORLY:'Consumer Discretionary', ULTA:'Consumer Discretionary',
    SKX:'Consumer Discretionary',  LEVI:'Consumer Discretionary',
    CROX:'Consumer Discretionary', BOOT:'Consumer Discretionary',
    BROS:'Consumer Discretionary', CAVA:'Consumer Discretionary',
    BJRI:'Consumer Discretionary', CHUY:'Consumer Discretionary',
    EAT:'Consumer Discretionary',  DPZ:'Consumer Discretionary',
    PLAY:'Consumer Discretionary', MELI:'Consumer Discretionary',

    // ── Consumer Staples (additional) ────────────────────────────────────────
    ADM:'Consumer Staples', MNST:'Consumer Staples', BJ:'Consumer Staples',
    SFM:'Consumer Staples', PFGC:'Consumer Staples', UNFI:'Consumer Staples',

    // ── Healthcare (additional) ───────────────────────────────────────────────
    A:'Healthcare',    CRL:'Healthcare',   WAT:'Healthcare',   NVST:'Healthcare',
    ZBH:'Healthcare',  ALGN:'Healthcare',  INSP:'Healthcare',  IRTC:'Healthcare',
    PODD:'Healthcare', NVCR:'Healthcare',  TMDX:'Healthcare',  TNDM:'Healthcare',
    ENSG:'Healthcare', LNTH:'Healthcare',  MDXG:'Healthcare',
    ACAD:'Healthcare', ALKS:'Healthcare',  AUPH:'Healthcare',
    BEAM:'Healthcare', CRSP:'Healthcare',  EDIT:'Healthcare',  FATE:'Healthcare',
    ARQT:'Healthcare', ARVN:'Healthcare',  IMVT:'Healthcare',  INVA:'Healthcare',
    IONS:'Healthcare', ITCI:'Healthcare',  KROS:'Healthcare',  KYMR:'Healthcare',
    NKTR:'Healthcare', NTLA:'Healthcare',  PRAX:'Healthcare',  PRTA:'Healthcare',
    PTCT:'Healthcare', RXDX:'Healthcare',  RXRX:'Healthcare',  SANA:'Healthcare',
    ACRS:'Healthcare', MDXG:'Healthcare',  BIO:'Healthcare',

    // ── Financials (additional) ───────────────────────────────────────────────
    DFS:'Financials',  AGO:'Financials',   ESNT:'Financials',  NMIH:'Financials',
    RDN:'Financials',  PFSI:'Financials',  UWMC:'Financials',  GHLD:'Financials',
    BANF:'Financials', CATY:'Financials',  CVBF:'Financials',  IBCP:'Financials',
    PPBI:'Financials', WSBC:'Financials',  TFIN:'Financials',  AMSF:'Financials',
    HMN:'Financials',  PIPR:'Financials',  SF:'Financials',

    // ── Energy (additional) ───────────────────────────────────────────────────
    LNG:'Energy',   CHRD:'Energy', CIVI:'Energy', CEIX:'Energy',
    CRGY:'Energy',  MTDR:'Energy', VTLE:'Energy', SM:'Energy',
    KOS:'Energy',   NGL:'Energy',  NINE:'Energy', PTEN:'Energy',
    PUMP:'Energy',  RES:'Energy',  GPRE:'Energy',

    // ── Industrials (additional) ──────────────────────────────────────────────
    MMM:'Industrials',  FAST:'Industrials', GWW:'Industrials',  ROK:'Industrials',
    WAB:'Industrials',  XYL:'Industrials',  CSWI:'Industrials', GXO:'Industrials',
    CPRT:'Industrials', TREX:'Industrials', UFPI:'Industrials', AWI:'Industrials',
    IBP:'Industrials',  BECN:'Industrials', AZEK:'Industrials', HXL:'Industrials',
    ARMK:'Industrials', DRS:'Industrials',  IESC:'Industrials', MYRG:'Industrials',
    NWPX:'Industrials', ATKR:'Industrials', CSWI:'Industrials',
    ACHR:'Industrials', JOBY:'Industrials', RKLB:'Industrials', LUNR:'Industrials',
    EVTL:'Industrials', RDW:'Industrials',  PLUG:'Industrials', BE:'Industrials',
    RUN:'Utilities',    PEG:'Utilities',

    // ── Real Estate (additional) ──────────────────────────────────────────────
    DEA:'Real Estate',  EGP:'Real Estate',  PLYM:'Real Estate',
    RHP:'Real Estate',  REXR:'Real Estate', STAG:'Real Estate',

    // ── Communication Services (additional) ───────────────────────────────────
    ASTS:'Communication Services',

    // ── ETFs (sector ETFs — keep sector identity so rotation works) ───────────
    XLK:'Technology',             XLC:'Communication Services',
    XLY:'Consumer Discretionary', XLP:'Consumer Staples',
    XLV:'Healthcare',             XLF:'Financials',
    XLE:'Energy',                 XLI:'Industrials',
    XLB:'Materials',              XLRE:'Real Estate',
    XLU:'Utilities',
    SMH:'Technology',             SOXX:'Technology',
    IBB:'Healthcare',             XBI:'Healthcare',
    KRE:'Financials',             KBE:'Financials',
    XOP:'Energy',                 OIH:'Energy',
    ITA:'Industrials',
    GLD:'Materials',              SLV:'Materials',
    // Broad market ETFs — no specific sector
    SPY:'Broad Market',  QQQ:'Technology',   IWM:'Broad Market',
    DIA:'Broad Market',  MDY:'Broad Market',
    TQQQ:'Technology',   SOXL:'Technology',  SOXS:'Technology',
    ARKK:'Technology',   ARKG:'Healthcare',  ARKF:'Financials',
    TLT:'Financials',    HYG:'Financials',   LQD:'Financials',
};

// ── Industry map — high-correlation clusters only ─────────────────────────────
// Full industry coverage isn't needed here; only groups where multiple holdings
// would create dangerous intra-portfolio correlation.  The bot caps per-industry
// at MAX_POSITIONS_PER_INDUSTRY (default 2) in the buy loop.
const INDUSTRY_MAP = {
    // Trucking / LTL / TL — all move together on freight data, fuel prices, DAT rates
    SNDR:'Trucking', CVLG:'Trucking', HTLD:'Trucking', KNX:'Trucking',
    JBHT:'Trucking', MRTN:'Trucking', ARCB:'Trucking', WERN:'Trucking',
    ODFL:'Trucking', SAIA:'Trucking', LSTR:'Trucking', USX:'Trucking',
    XPO:'Trucking',  RXO:'Trucking',  CHRW:'Trucking',

    // Airlines — all move on jet fuel, load factor, TSA data
    DAL:'Airlines', UAL:'Airlines', AAL:'Airlines', LUV:'Airlines',
    ALGT:'Airlines', ALK:'Airlines', JBLU:'Airlines', SAVE:'Airlines',
    ULCC:'Airlines', MESA:'Airlines', SKYW:'Airlines',

    // Semiconductors — highly correlated; one SOX move hits all
    NVDA:'Semiconductors', AMD:'Semiconductors', INTC:'Semiconductors',
    QCOM:'Semiconductors', AVGO:'Semiconductors', MCHP:'Semiconductors',
    SWKS:'Semiconductors', QRVO:'Semiconductors', TXN:'Semiconductors',
    ADI:'Semiconductors',  MU:'Semiconductors',  ON:'Semiconductors',
    MPWR:'Semiconductors', SMCI:'Semiconductors', ARM:'Semiconductors',
    ALAB:'Semiconductors',
    // Semi equipment
    AMAT:'Semiconductor Equipment', LRCX:'Semiconductor Equipment',
    KLAC:'Semiconductor Equipment', ONTO:'Semiconductor Equipment',
    FORM:'Semiconductor Equipment', COHU:'Semiconductor Equipment',

    // Regional banks — move together on rate curve & credit spreads
    USB:'Regional Banks',  PNC:'Regional Banks',  TFC:'Regional Banks',
    RF:'Regional Banks',   HBAN:'Regional Banks', CFG:'Regional Banks',
    KEY:'Regional Banks',  FITB:'Regional Banks', MTB:'Regional Banks',
    ZION:'Regional Banks', CMA:'Regional Banks',  FHN:'Regional Banks',
    SNV:'Regional Banks',  EWBC:'Regional Banks', WTFC:'Regional Banks',
    CBSH:'Regional Banks', FNB:'Regional Banks',

    // Money-center banks — large caps but still correlated
    JPM:'Money Center Banks', BAC:'Money Center Banks',
    WFC:'Money Center Banks', C:'Money Center Banks',
    GS:'Money Center Banks',  MS:'Money Center Banks',

    // Energy E&P — move with crude / nat gas
    XOM:'Oil & Gas E&P', CVX:'Oil & Gas E&P', COP:'Oil & Gas E&P',
    OXY:'Oil & Gas E&P', HES:'Oil & Gas E&P', DVN:'Oil & Gas E&P',
    FANG:'Oil & Gas E&P',EOG:'Oil & Gas E&P', PXD:'Oil & Gas E&P',
    APA:'Oil & Gas E&P', MRO:'Oil & Gas E&P',

    // Biotech — high binary event risk; correlated on FDA/sector sentiment
    BIIB:'Biotech', VRTX:'Biotech', REGN:'Biotech', ILMN:'Biotech',
    MRNA:'Biotech', BNTX:'Biotech', NVAX:'Biotech', SRPT:'Biotech',
    ALNY:'Biotech', INCY:'Biotech', EXAS:'Biotech',

    // Cloud software — correlated on ARR multiples & rate sensitivity
    CRM:'Cloud Software', NOW:'Cloud Software',  WDAY:'Cloud Software',
    SNOW:'Cloud Software', DDOG:'Cloud Software', MDB:'Cloud Software',
    ZS:'Cloud Software',   PANW:'Cloud Software', CRWD:'Cloud Software',
    NET:'Cloud Software',  HUBS:'Cloud Software', TEAM:'Cloud Software',
    PLTR:'Cloud Software',

    // EV / Clean energy — correlated on policy and rate sensitivity
    TSLA:'EV & Clean Energy', RIVN:'EV & Clean Energy', LCID:'EV & Clean Energy',
    NIO:'EV & Clean Energy',  XPEV:'EV & Clean Energy', LI:'EV & Clean Energy',
    ENPH:'EV & Clean Energy', SEDG:'EV & Clean Energy', FSLR:'EV & Clean Energy',

    // Homebuilders — all move on 30-yr mortgage rate
    DHI:'Homebuilders', LEN:'Homebuilders', PHM:'Homebuilders',
    TOL:'Homebuilders', NVR:'Homebuilders', KBH:'Homebuilders',
    MDC:'Homebuilders', MHO:'Homebuilders',

    // Cruise lines — correlated consumer travel
    RCL:'Cruise Lines', CCL:'Cruise Lines', NCLH:'Cruise Lines',

    // Social media / digital ads
    META:'Digital Advertising', GOOGL:'Digital Advertising',
    GOOG:'Digital Advertising',  SNAP:'Digital Advertising',
    PINS:'Digital Advertising',  TTD:'Digital Advertising',
};

const MAX_POSITIONS_PER_INDUSTRY = 2; // hard cap — prevents trucking cluster, semi cluster, etc.

/**
 * Look up sector for a ticker symbol.
 * Returns the Yahoo-compatible sector string, or null if unknown.
 * @param {string} symbol
 * @returns {string|null}
 */
function getSector(symbol) {
    if (!symbol) return null;
    return SECTOR_MAP[symbol.toUpperCase()] || null;
}

/**
 * Look up industry group for a ticker symbol.
 * Returns the industry string, or null if not in the high-correlation map.
 * @param {string} symbol
 * @returns {string|null}
 */
function getIndustry(symbol) {
    if (!symbol) return null;
    return INDUSTRY_MAP[symbol.toUpperCase()] || null;
}

// ── Auto-learning cache ───────────────────────────────────────────────────────
// Persists Yahoo-supplied sectors across restarts so new tickers are remembered
// without requiring manual updates to SECTOR_MAP.
// File location: same directory as this service for simplicity.

const path = require('path');
const fs   = require('fs');

const LEARNED_PATH = path.join(__dirname, 'sectorLearnedCache.json');

let _learned = {};
try {
    if (fs.existsSync(LEARNED_PATH)) {
        _learned = JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf8'));
    }
} catch { _learned = {}; }

let _savePending = false;
function _persistLearned() {
    if (_savePending) return;
    _savePending = true;
    setImmediate(() => {
        try { fs.writeFileSync(LEARNED_PATH, JSON.stringify(_learned, null, 2)); } catch { /* non-fatal */ }
        _savePending = false;
    });
}

/**
 * Called by analyzeStockWithAI() when Yahoo returns a valid sector.
 * Teaches the cache so future scans don't fall back to 'Unknown'.
 */
function learnSector(symbol, sector) {
    if (!symbol || !sector || sector === 'Unknown' || sector === '') return;
    const key = symbol.toUpperCase();
    if (_learned[key] !== sector) {
        _learned[key] = sector;
        _persistLearned();
    }
}

/**
 * Resolve sector with priority:
 *   1. Live Yahoo quote sector (most accurate)
 *   2. Static SECTOR_MAP (curated, ~500 symbols)
 *   3. Learned cache (auto-populated from past Yahoo quotes)
 *   4. 'Unknown' (fallback — STANDARD trade profile, no rotation logic)
 * @param {string} symbol
 * @param {string|null} quoteSector
 * @returns {string}
 */
function resolveSector(symbol, quoteSector) {
    if (quoteSector && quoteSector !== 'Unknown' && quoteSector !== '') {
        learnSector(symbol, quoteSector);   // teach cache for next time
        return quoteSector;
    }
    const key = symbol ? symbol.toUpperCase() : '';
    return SECTOR_MAP[key] || _learned[key] || 'Unknown';
}

/**
 * Resolve industry with priority: live quote industry > static map > null.
 * @param {string} symbol
 * @param {string|null} quoteIndustry
 * @returns {string|null}
 */
function resolveIndustry(symbol, quoteIndustry) {
    if (quoteIndustry && quoteIndustry !== 'Unknown' && quoteIndustry !== '') {
        // Still prefer the static map for our known high-correlation clusters —
        // the static names are normalised (e.g. "Trucking" not "Freight & Logistics")
        return getIndustry(symbol) || quoteIndustry;
    }
    return getIndustry(symbol) || null;
}

module.exports = { getSector, getIndustry, resolveSector, resolveIndustry, learnSector, MAX_POSITIONS_PER_INDUSTRY };
