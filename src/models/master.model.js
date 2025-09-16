const User = require('../../models/user.model');
const AuthToken = require('../../models/authToken.model');
const StsToken = require('../../models/stsToken.model');
const logger = require('../utils/logger');

async function checkCronPriorityFlagActiveOrNotForAnyAgencyUser() {
    try {
        const isActive = await User.checkCronPriorityFlagActive();
        logger.debug({ isActive }, 'checkCronPriorityFlagActiveOrNotForAnyAgencyUser');
        return isActive;
    } catch (error) {
        logger.error({ error: error.message }, 'Error in checkCronPriorityFlagActiveOrNotForAnyAgencyUser');
        throw error;
    }
}

async function getAllAgencyUserList() {
    try {
        const users = await User.getAllAgencyUserList();
        logger.debug({ count: users.length }, 'getAllAgencyUserList');
        return users;
    } catch (error) {
        logger.error({ error: error.message }, 'Error in getAllAgencyUserList');
        throw error;
    }
}

async function getSavedToken(amazonSellerID) {
    try {
        const token = await AuthToken.getSavedToken(amazonSellerID);
        logger.debug({ amazonSellerID, found: !!token }, 'getSavedToken');
        return token;
    } catch (error) {
        logger.error({ error: error.message, amazonSellerID }, 'Error in getSavedToken');
        throw error;
    }
}

// STS details will also be sourced from DB; table name can be set via env if different
async function getStsTokenDetails() {
    try {
        const token = await StsToken.getLatestTokenDetails();
        logger.debug({ found: !!token }, 'getStsTokenDetails');
        return token;
    } catch (error) {
        logger.warn({ error: error.message }, 'STS token table not found or accessible');
        return null;
    }
}

module.exports = { getAllAgencyUserList, getSavedToken, getStsTokenDetails };
// Back-compat alias name matching PHP
module.exports.getAuthTokenBySellerId = getSavedToken;


