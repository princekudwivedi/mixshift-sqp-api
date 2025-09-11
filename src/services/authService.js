const masterModel = require('../models/masterModel');

async function getAccessToken(amazonSellerID) {
	try {
		const tokenRow = await masterModel.getSavedToken(amazonSellerID);
		return tokenRow && tokenRow.access_token ? tokenRow.access_token : null;
	} catch (e) {
		return null;
	}
}

module.exports = {
	getAccessToken,
};


