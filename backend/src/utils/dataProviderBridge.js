/**
 * Thin bridge from utils/yfClient → services/dataProvider.
 * Exists solely to avoid a circular-require between the two directories.
 * Lazy-loaded so it only resolves when actually needed.
 */
let _provider = null;
function getProvider() {
    if (!_provider) _provider = require('../services/dataProvider');
    return _provider;
}

module.exports = {
    getQuote:       (symbol)                    => getProvider().getQuote(symbol),
    getBars:        (symbol, interval, days)    => getProvider().getBars(symbol, interval, days),
    searchSymbols:  (query)                     => getProvider().searchSymbols(query),
    getOptionsChain:(symbol)                    => getProvider().getOptionsChain(symbol)
};
