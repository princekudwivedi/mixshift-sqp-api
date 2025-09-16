const { amazonSpApi } = require('../config/env.config');

function getSPAPIURLBasedOnRegion(merchantRegion) {
	const region = String(merchantRegion || '').toUpperCase();
	if (region === 'NA' || region === 'US' || region === 'CA' || region === 'MX') {
		return amazonSpApi.baseUrl.replace(/\/$/, '');
	}
	if (region === 'EU' || region === 'UK' || region === 'DE' || region === 'FR' || region === 'IT' || region === 'ES' || region === 'NL' || region === 'SE' || region === 'PL' || region === 'TR' || region === 'AE' || region === 'SA') {
		return amazonSpApi.europeBaseUrl.replace(/\/$/, '');
	}
	// Default FE (JP, AU, SG, IN)
	return amazonSpApi.asiaBaseUrl.replace(/\/$/, '');
}

module.exports = {
	getSPAPIURLBasedOnRegion,
};


