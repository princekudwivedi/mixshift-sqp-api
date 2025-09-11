const { query } = require('../db/mysql');
const { tables } = require('../config/env');
const logger = require('../utils/logger');

async function checkCronPriorityFlagActiveOrNotForAnyAgencyUser() {
    const sql = `SELECT COUNT(1) AS cnt
                 FROM ${tables.users} AS user
                 WHERE user.iActive = '1'
                   AND user.iParentID = '0'
                   AND user.iUserType = '2'
                   AND user.isDeleted = '0'
                   AND user.isDemoUser = '0'
                   AND user.iCronPriorityFlag = '1'`;
    const rows = await query(sql);
    return (rows && rows[0] && Number(rows[0].cnt) > 0);
}

async function getAllAgencyUserList() {
    // Mirrors PHP Script_Model->getAllAgencyUserList() with CronPriorityFlag-aware ordering
    const priorityActive = await checkCronPriorityFlagActiveOrNotForAnyAgencyUser();    
    const orderBy = priorityActive
        ? 'ORDER BY user.iCronPriorityFlag DESC, user.dtUpdatedOn ASC, user.ID ASC'
        : 'ORDER BY time.GMT_Value DESC, user.ID ASC';

    const sql = `
        SELECT 
            user.ID,
            user.Email,
            user.AgencyName,
            user.iCronPriorityFlag,
            user.dtUpdatedOn,
            DB.DB_Name,
            DB.DomainName,
            time.Timezone,
            time.GMT_Value
        FROM ${tables.users} AS user
        LEFT JOIN ${tables.userDbMap} AS map ON map.UserID = user.ID
        LEFT JOIN ${tables.userDbs} AS DB ON map.MappedDB_ID = DB.DB_ID
        LEFT JOIN ${tables.timezones} AS time ON user.iTimezoneID = time.ID
        WHERE user.iActive = '1'
          AND user.iParentID = '0'
          AND user.iUserType != '4'
          AND user.isDeleted = '0'
          AND user.isDemoUser = '0'
          AND DB.DB_Name <> ''
          AND DB.DomainName <> ''
        ${orderBy}
    `;
    return query(sql);
}

async function getSavedToken(amazonSellerID) {
    // Mirror Auth_Model->getSavedToken: get access_token and refresh_token from tbl_sp_api_authorization
    const sql = `
        SELECT id, AmazonSellerID, access_token, refresh_token, expires_in
        FROM tbl_sp_api_authorization
        WHERE AmazonSellerID = ?
        ORDER BY id DESC LIMIT 1
    `;
    const rows = await query(sql, [amazonSellerID]);
    return rows[0] || null;
}

// STS details will also be sourced from DB; table name can be set via env if different
async function getStsTokenDetails() {
    try {
        const sql = `SELECT id, accessKeyId, secretAccessKey, SessionToken, expire_at
                     FROM ${tables.stsTokens}
                     ORDER BY id DESC LIMIT 1`;
        const rows = await query(sql);
        return rows[0] || null;
    } catch (error) {
        logger.warn({ error: error.message, table: tables.stsTokens }, 'STS token table not found or accessible');
        return null;
    }
}

module.exports = { getAllAgencyUserList, getSavedToken, getStsTokenDetails };
// Back-compat alias name matching PHP
module.exports.getAuthTokenBySellerId = getSavedToken;


