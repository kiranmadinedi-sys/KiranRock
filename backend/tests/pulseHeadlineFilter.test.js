/** Law-firm solicitation ads are dropped before PULSE reads headlines (2026-11-04). */
const { filterHeadlines } = require('../src/services/geminiPulseService');

describe('filterHeadlines', () => {
    test('drops law-firm ads', () => {
        const ads = [
            'Securities Fraud Investigation Into Upwork Inc. (UPWK) Continues – Shareholders Who Lost Money Urged To Contact Glancy Prongay',
            'UPWK Investors Have Opportunity to Join Upwork Inc. Fraud Investigation with the Schall Law Firm',
            'Levi & Korsinsky Announces Investigation of Securities Claims Against Upwork Inc. (UPWK)',
            'INVESTOR ALERT: Investigation of Upwork Inc. (UPWK) announced by Holzer & Holzer, LLC',
            'DEADLINE ALERT for WOLF, HUMA, XRX, and ZETA: The Law Offices of Frank R. Cruz Reminds Investors of Class Actions',
            'Xerox Holdings Corporation Investors: Please contact the Portnoy Law Firm to recover your losses',
        ];
        expect(filterHeadlines(ads)).toEqual([]);
    });

    test('keeps real news, including real enforcement news', () => {
        const news = [
            'Xerox Stock Plunges 40.3% Despite Q3 Earnings and Revenues Beat',
            'NiSource Set For Outperformance But CenterPoint Energy Faces Regulatory Hurdles, Says BofA Analyst',
            'SEC Charges Acme Corp With Accounting Fraud',
            'Acme Receives Nasdaq Delisting Notice',
            'Acme Restates Three Years of Results After Auditor Resigns',
        ];
        expect(filterHeadlines(news)).toEqual(news);
    });
});
