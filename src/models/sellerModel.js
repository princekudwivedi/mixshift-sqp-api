const { query } = require('../db/mysql');
const { tables } = require('../config/env');
// no direct process.env usage in SQL; use configured tables instead

async function getSellersProfilesForCron(idUserAccount) {    
    // Mirrors PHP Script_Model->getSellersProfilesForCron($idUserAccount)
    const cronEndDate = new Date(Date.now() - 24*60*60*1000).toISOString().slice(0,10);
    
    const sql = `
        SELECT 
            sell.ID AS idSellerAccount,
            sell.Name AS SellerName,
            sell.MerchantRegion AS MerchantRegion,
            sell.AmazonSellerID,
            sell.ProfileId,
            sell.idUserAccount,
            sell.MerchantType,
            sell.isAdLostAccess,
            sell.pull60DaysReportFlag,
            mp.ID AS idMarketPlaceAccount,
            mp.Name AS MarketPlaceName,
            mp.CountryCode AS CountryCode,
            mp.AmazonMarketplaceId,
            (
              SELECT COUNT(ID)
              FROM ${tables.cronDetails} AS cron
              WHERE cron.SellerId = sell.id AND cron.cronEndDate = ?
            ) AS cron_count
        FROM ${tables.seller} AS sell
        LEFT JOIN ${tables.sellerMarketPlacesMapping} AS smpm ON smpm.SellerId = sell.id
        LEFT JOIN ${tables.marketPlace} AS mp ON mp.id = smpm.MarketId
        WHERE sell.idUserAccount = ?
          AND sell.IsActive = '1'
          AND sell.MerchantType != 'Agency'
        ORDER BY sell.pull60DaysReportFlag DESC, cron_count ASC, idSellerAccount ASC
    `;
    return query(sql, [cronEndDate, Number(idUserAccount)]);
}

async function getProfileDetailsByID(profileId) {
    // Align with PHP getProfileDetailsByID - search by ProfileId, not ID
    const sql = `
        SELECT 
            sell.ID AS idSellerAccount,
            sell.Name AS SellerName,
            sell.MerchantRegion,
            sell.AmazonSellerID,
            sell.ProfileId,
            sell.idUserAccount,
            sell.MerchantType,
            sell.isAdLostAccess,
            sell.IsActive,
            sell.isMwsUser,
            sell.iDataCopyStatus,
            sell.dtLastCopyStartTime,
            sell.ACOSTarget,
            sell.MonthlyBudget,
            mp.ID AS idMarketPlaceAccount,
            mp.Name AS MarketPlaceName,
            mp.AmazonMarketplaceId,
            mp.CountryCode,
            mp.CurrencyCode
        FROM ${tables.seller} AS sell
        LEFT JOIN ${tables.sellerMarketPlacesMapping} AS smpm ON smpm.SellerId = sell.id
        LEFT JOIN ${tables.marketPlace} AS mp ON mp.id = smpm.MarketId
        WHERE sell.ProfileId = ?
        LIMIT 1`;
    const rows = await query(sql, [profileId]);
    return rows[0] || null;
}

async function getProfileDetailsByAmazonSellerID(amazonSellerID) {
    // Align with PHP getProfileDetailsByAmazonSellerID - search by amazonSellerID, not ID
    const sql = `
        SELECT 
            sell.ID AS idSellerAccount,
            sell.Name AS SellerName,
            sell.MerchantRegion,
            sell.AmazonSellerID,
            sell.ProfileId,
            sell.idUserAccount,
            sell.MerchantType,
            sell.isAdLostAccess,
            sell.IsActive,
            sell.isMwsUser,
            sell.iDataCopyStatus,
            sell.dtLastCopyStartTime,
            sell.ACOSTarget,
            sell.MonthlyBudget,
            mp.ID AS idMarketPlaceAccount,
            mp.Name AS MarketPlaceName,
            mp.AmazonMarketplaceId,
            mp.CountryCode,
            mp.CurrencyCode
        FROM ${tables.seller} AS sell
        LEFT JOIN ${tables.sellerMarketPlacesMapping} AS smpm ON smpm.SellerId = sell.id
        LEFT JOIN ${tables.marketPlace} AS mp ON mp.id = smpm.MarketId
        WHERE sell.AmazonSellerID = ?
        LIMIT 1`;
    const rows = await query(sql, [amazonSellerID]);
    return rows[0] || null;
}

async function getProfileDetailsByAmazonSellerID11(amazonSellerID) {
    // Search by AmazonSellerID - mirror PHP getSellersProfiles function
    console.log('getProfileDetailsByAmazonSellerID called with:', amazonSellerID);
    
    // First, let's check what sellers exist in the current database
    const checkSql = `SELECT ID, AmazonSellerID, Name, ProfileId FROM ${tables.seller} LIMIT 5`;
    const allSellers = await query(checkSql);
    console.log('All sellers in current database:', JSON.stringify(allSellers, null, 2));
    
    const sql = `
        SELECT 
            sell.ID AS idSellerAccount,
            sell.Name AS SellerName,
            sell.AmazonSellerID,
            sell.ProfileId,
            sell.idUserAccount,
            sell.MerchantType,
            sell.MerchantRegion,
            sell.isAdLostAccess,
            mp.ID AS idMarketPlaceAccount,
            mp.Name AS MarketPlaceName,
            mp.CountryCode AS CountryCode,
            mp.AmazonMarketplaceId
        FROM ${tables.seller} AS sell
        LEFT JOIN ${tables.sellerMarketPlacesMapping} AS smpm ON smpm.SellerId = sell.id
        LEFT JOIN ${tables.marketPlace} AS mp ON mp.id = smpm.MarketId
        WHERE sell.AmazonSellerID = ?
          AND sell.IsActive = '1'
          AND sell.MerchantType != 'Agency'
        LIMIT 1`;
    
    console.log('SQL to execute:', sql);
    console.log('Parameter:', amazonSellerID);
    
    const rows = await query(sql, [amazonSellerID]);
    console.log('Query result:', JSON.stringify(rows, null, 2));
    
    return rows[0] || null;
}

module.exports = { getSellersProfilesForCron, getProfileDetailsByID, getProfileDetailsByAmazonSellerID };

// Advanced variant mirroring SP_API_Model->getSellersProfilesForCron
async function checkCronPriorityFlagActiveOrNotForAnyMerchant() {
    const sql = `SELECT COUNT(1) AS cnt FROM ${tables.seller} WHERE isMwsUser = '1' AND iPriorityFlag = '1'`;
    const rows = await query(sql);
    return (rows && rows[0] && Number(rows[0].cnt) > 0);
}

async function getSellersProfilesForCronAdvanced({ idSellerAccount = 0, pullAll = 0, AmazonSellerID = '', marketplacename = '', marketplaceAry = [], isCustomPull = 0 } = {}) {
    const priorityActive = await checkCronPriorityFlagActiveOrNotForAnyMerchant();
    const orderBy = priorityActive
        ? 'ORDER BY sell.iPriorityFlag DESC, priorityFlagUpdatedOn ASC'
        : 'ORDER BY sell.dtMwsActivatedOn ASC';

    const conditions = ["sell.isMwsUser = '1'"];
    const values = [];
    if (idSellerAccount > 0) { conditions.push('sell.ID = ?'); values.push(Number(idSellerAccount)); }
    if (AmazonSellerID) { conditions.push('sell.AmazonSellerID = ?'); values.push(AmazonSellerID); }
    if (marketplacename) { conditions.push('sell.MarketPlaceName = ?'); values.push(marketplacename); }
    if (Array.isArray(marketplaceAry) && marketplaceAry.length) {
        conditions.push(`mp.ID IN (${marketplaceAry.map(() => '?').join(',')})`);
        values.push(...marketplaceAry.map(Number));
    }
    if (isCustomPull === 1) { conditions.push('sell.isCustomInitialPull = 1'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
        SELECT 
            sell.ID as idSellerAccount,
            sell.Name as SellerName,
            sell.MerchantRegion as MerchantRegion,
            sell.AmazonSellerID,
            sell.ProfileId,
            sell.IsActive,
            sell.isMwsUser,
            sell.MarketPlaceID,
            sell.idUserAccount,
            sell.dtMwsActivatedOn,
            sell.MerchantType,
            sell.isSpApiBackfillPull,
            sell.pull60DaysReportFlag,
            sell.isMwsInitialReportDataPulled,
            sell.dateFromToPullMwsData,
            sell.AgencyName,
            sell.isSpApiBackfillPull,
            sell.isOrderMetricInitialPullVerified,
            sell.isOrderInitialPullVerified,
            sell.isSpApiBackfillPull,
            la.dtLostAccessOn,
            mp.ID as idMarketPlaceAccount,
            mp.Name as MarketPlaceName,
            mp.CountryCode as CountryCode,
            mp.AmazonMarketplaceId,
            sell.isMwsInventoryInitialDataPulled,
            sell.initialPullAfterLostAccess,
            la.iLostAccess,
            la.auth_token,
            sell.iRunningInitialPull,
            ma.developerId,
            sell.iPriorityFlag,
            sell.dtInventoryDataPulled,
            sell.isLargeMwsDataMerchant,
            sell.isBrandAnalyticsLostAccess,
            sell.isAnalyticsInitialPull,
            sell.iCustomUpdateStatus,
            sell.isCustomInitialPull
        FROM ${tables.seller} AS sell
        LEFT JOIN ${tables.sellerMarketPlacesMapping} AS smpm ON smpm.SellerId = sell.id
        LEFT JOIN ${tables.marketPlace} AS mp ON mp.id = smpm.MarketId
        LEFT JOIN ${tables.oauthTokens} AS la ON la.AmazonSellerID = sell.AmazonSellerID
        LEFT JOIN ${tables.mwsAccessKeys} AS ma ON ma.MerchantRegion = sell.MerchantRegion
        ${where}
        ${orderBy}
    `;

    const rows = await query(sql, values);
    if (pullAll === 0) {
        const seen = new Set();
        return rows.filter(r => { if (seen.has(r.AmazonSellerID)) return false; seen.add(r.AmazonSellerID); return true; });
    }
    return rows;
}

module.exports.getSellersProfilesForCronAdvanced = getSellersProfilesForCronAdvanced;


