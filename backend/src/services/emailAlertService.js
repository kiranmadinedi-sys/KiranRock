const nodemailer = require('nodemailer');

/**
 * Email Alert Service
 * Sends email notifications for:
 * - High-severity news alerts
 * - Options trading opportunities
 * - AI trading signals
 * 
 * Setup: Configure SMTP settings in environment variables
 * For Gmail: Enable "App Passwords" in Google Account settings
 */

// Email configuration from environment variables
const EMAIL_CONFIG = {
    service: process.env.EMAIL_SERVICE || 'gmail', // 'gmail', 'outlook', 'yahoo', etc.
    auth: {
        user: process.env.EMAIL_USER || '', // Your email address
        pass: process.env.EMAIL_PASSWORD || '' // App password or regular password
    }
};

// Create transporter
let transporter = null;

/**
 * Initialize email transporter
 */
function initializeTransporter() {
    if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
        console.warn('[Email Service] Email credentials not configured. Set EMAIL_USER and EMAIL_PASSWORD environment variables.');
        console.warn('[Email Service] Email alerts will be logged to console only.');
        return null;
    }
    
    try {
        transporter = nodemailer.createTransporter({
            service: EMAIL_CONFIG.service,
            auth: EMAIL_CONFIG.auth
        });
        
        console.log('[Email Service] Email transporter initialized successfully');
        return transporter;
    } catch (error) {
        console.error('[Email Service] Error initializing transporter:', error.message);
        return null;
    }
}

/**
 * Send email
 * @param {Object} emailData - Email details
 * @returns {Promise<Object>} Send result
 */
async function sendEmail(emailData) {
    const { to, subject, html, text } = emailData;
    
    // Log to console if transporter not configured
    if (!transporter) {
        console.log('[Email Service] Would send email:');
        console.log(`  To: ${to}`);
        console.log(`  Subject: ${subject}`);
        console.log(`  Content: ${text || html}`);
        return { logged: true };
    }
    
    try {
        const mailOptions = {
            from: `Stock Trading Bot <${EMAIL_CONFIG.auth.user}>`,
            to,
            subject,
            html: html || `<pre>${text}</pre>`,
            text: text || html
        };
        
        const info = await transporter.sendMail(mailOptions);
        console.log('[Email Service] Email sent:', info.messageId);
        return info;
    } catch (error) {
        console.error('[Email Service] Error sending email:', error.message);
        throw error;
    }
}

/**
 * Send news alert email
 * @param {string} recipientEmail - Recipient email address
 * @param {Object} alert - News alert data
 */
async function sendNewsAlert(recipientEmail, alert) {
    const subject = `🚨 ${alert.severity} Impact News: ${alert.symbol}`;
    
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e40af;">${alert.title}</h2>
            
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Symbol:</strong> ${alert.symbol}</p>
                <p><strong>Severity:</strong> <span style="color: ${alert.severity === 'High' ? '#dc2626' : '#f59e0b'};">${alert.severity}</span></p>
                <p><strong>Sentiment:</strong> ${alert.sentiment}</p>
                <p><strong>Time:</strong> ${new Date(alert.publishedAt).toLocaleString()}</p>
            </div>
            
            <p>${alert.summary}</p>
            
            <p><strong>Keywords:</strong> ${alert.keywords?.join(', ') || 'N/A'}</p>
            
            <a href="${alert.url}" style="display: inline-block; background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px;">
                Read Full Article
            </a>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            
            <p style="color: #6b7280; font-size: 12px;">
                This is an automated alert from your Stock Trading Bot. 
                <br>To unsubscribe, update your notification preferences in your profile.
            </p>
        </div>
    `;
    
    return await sendEmail({
        to: recipientEmail,
        subject,
        html
    });
}

/**
 * Send options opportunity email
 * @param {string} recipientEmail - Recipient email address
 * @param {Object} opportunity - Options opportunity data
 */
async function sendOptionsAlert(recipientEmail, opportunity) {
    const subject = `💰 Options Opportunity: ${opportunity.symbol} ${opportunity.type.toUpperCase()} $${opportunity.strike}`;
    
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">${opportunity.symbol} ${opportunity.type.toUpperCase()} Option</h2>
            
            <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Strike Price:</strong> $${opportunity.strike}</p>
                <p><strong>Expiration:</strong> ${opportunity.expiration} (${opportunity.daysToExpiration} days)</p>
                <p><strong>Last Price:</strong> $${opportunity.lastPrice}</p>
                <p><strong>Market Cap:</strong> ${opportunity.marketCap}</p>
                <p><strong>Scan Time:</strong> ${opportunity.scanTime}</p>
            </div>
            
            <h3 style="color: #1e40af;">Greeks Analysis</h3>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Delta:</strong> ${opportunity.delta} <span style="color: #6b7280;">- Price sensitivity</span></p>
                <p><strong>Gamma:</strong> ${opportunity.gamma} <span style="color: #6b7280;">- Delta change rate</span></p>
                <p><strong>Theta:</strong> ${opportunity.theta}/day <span style="color: #6b7280;">- Time decay</span></p>
                <p><strong>Vega:</strong> ${opportunity.vega} <span style="color: #6b7280;">- Volatility sensitivity</span></p>
            </div>
            
            <h3 style="color: #1e40af;">Liquidity</h3>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Volume:</strong> ${opportunity.volume}</p>
                <p><strong>Open Interest:</strong> ${opportunity.openInterest}</p>
                <p><strong>Bid/Ask:</strong> $${opportunity.bid} / $${opportunity.ask}</p>
            </div>
            
            <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>⚠️ Risk Disclaimer:</strong> Options trading involves significant risk. This is an informational alert only and not financial advice. Always do your own research and consider consulting a financial advisor.</p>
            </div>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            
            <p style="color: #6b7280; font-size: 12px;">
                This is an automated alert from your Stock Trading Bot. 
                <br>To unsubscribe, update your notification preferences in your profile.
            </p>
        </div>
    `;
    
    return await sendEmail({
        to: recipientEmail,
        subject,
        html
    });
}

/**
 * Send AI trading signal email
 * @param {string} recipientEmail - Recipient email address
 * @param {Object} signal - AI trading signal data
 */
async function sendAITradingAlert(recipientEmail, signal) {
    const subject = `🤖 AI Trading Signal: ${signal.action} ${signal.symbol}`;
    
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #7c3aed;">AI Trading Signal</h2>
            
            <div style="background: ${signal.action === 'BUY' ? '#f0fdf4' : '#fef2f2'}; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Action:</strong> <span style="font-size: 24px; color: ${signal.action === 'BUY' ? '#059669' : '#dc2626'};">${signal.action}</span></p>
                <p><strong>Symbol:</strong> ${signal.symbol}</p>
                <p><strong>Confidence:</strong> ${signal.confidence}%</p>
                <p><strong>Entry Price:</strong> $${signal.entryPrice}</p>
            </div>
            
            <h3 style="color: #1e40af;">Trade Details</h3>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                ${signal.targetPrice ? `<p><strong>Target Price:</strong> $${signal.targetPrice}</p>` : ''}
                ${signal.stopLoss ? `<p><strong>Stop Loss:</strong> $${signal.stopLoss}</p>` : ''}
                ${signal.riskRewardRatio ? `<p><strong>Risk/Reward:</strong> ${signal.riskRewardRatio}</p>` : ''}
                <p><strong>Reasoning:</strong> ${signal.reasoning}</p>
            </div>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            
            <p style="color: #6b7280; font-size: 12px;">
                This is an automated alert from your Stock Trading Bot AI. 
                <br>Always review signals before executing trades.
            </p>
        </div>
    `;
    
    return await sendEmail({
        to: recipientEmail,
        subject,
        html
    });
}

/**
 * Send daily summary email
 * @param {string} recipientEmail - Recipient email address
 * @param {Object} summary - Daily summary data
 */
async function sendDailySummary(recipientEmail, summary) {
    const subject = `📊 Daily Trading Summary - ${new Date().toLocaleDateString()}`;
    
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e40af;">Daily Trading Summary</h2>
            
            <h3>Portfolio Performance</h3>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Total Value:</strong> $${summary.totalValue?.toFixed(2) || 'N/A'}</p>
                <p><strong>Daily P/L:</strong> <span style="color: ${(summary.dailyPL || 0) >= 0 ? '#059669' : '#dc2626'};">${summary.dailyPL >= 0 ? '+' : ''}$${summary.dailyPL?.toFixed(2) || '0.00'}</span></p>
                <p><strong>Win Rate:</strong> ${summary.winRate?.toFixed(1) || 'N/A'}%</p>
            </div>
            
            <h3>Today's Activity</h3>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Trades Executed:</strong> ${summary.tradesCount || 0}</p>
                <p><strong>News Alerts:</strong> ${summary.newsAlertsCount || 0}</p>
                <p><strong>Options Opportunities:</strong> ${summary.optionsOpportunitiesCount || 0}</p>
            </div>
            
            ${summary.topPerformers?.length > 0 ? `
                <h3>Top Performers</h3>
                <ul>
                    ${summary.topPerformers.map(stock => `
                        <li><strong>${stock.symbol}:</strong> <span style="color: #059669;">+${stock.change}%</span></li>
                    `).join('')}
                </ul>
            ` : ''}
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            
            <p style="color: #6b7280; font-size: 12px;">
                Daily summary from your Stock Trading Bot.
            </p>
        </div>
    `;
    
    return await sendEmail({
        to: recipientEmail,
        subject,
        html
    });
}

// Initialize on module load
initializeTransporter();

module.exports = {
    sendEmail,
    sendNewsAlert,
    sendOptionsAlert,
    sendAITradingAlert,
    sendDailySummary,
    initializeTransporter
};
