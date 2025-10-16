const { DataTypes, Op } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

const { TBL_SELLER } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');
const SellerMarketplacesMapping = require('./sellerMarketplacesMapping.model');
const Marketplace = require('./marketplace.model');
const MwsOauthToken = require('./mwsOauthToken.model');
const MwsAccessKeys = require('./mwsAccessKeys.model');

const table = TBL_SELLER;

// Cache for lazy-loaded model
let cachedModel = null;
let cachedUserId = null;

// Model definition structure (used for lazy loading)
const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AgencyName: { type: DataTypes.STRING(255) },
    MerchantAlias: { type: DataTypes.STRING(100) },
    Name: { type: DataTypes.STRING(100) },
    AmazonSellerID: { type: DataTypes.STRING(100) },
    ProfileId: { type: DataTypes.STRING(100) },
    MarketPlaceID: { type: DataTypes.INTEGER },
    MarketPlaceName: { type: DataTypes.STRING(100) },
    idUserAccount: { type: DataTypes.INTEGER },
    MerchantType: { type: DataTypes.STRING(200) },
    IsActive: { type: DataTypes.TINYINT },
    isAdLostAccess: { type: DataTypes.TINYINT },
    HideFromAdvertisingPlatform: { type: DataTypes.TINYINT },
    ACOSTarget: { type: DataTypes.DECIMAL(10,2) },
    MonthlyBudget: { type: DataTypes.DECIMAL(10,2) },
    DailyBudget: { type: DataTypes.BIGINT },
    MerchantRegion: { type: DataTypes.STRING(150) },
    DashAgencyID: { type: DataTypes.INTEGER },
    pull60DaysReportFlag: { type: DataTypes.TINYINT },
    iRunning60DaysPull: { type: DataTypes.TINYINT },
    dtDataPurgeDate: { type: DataTypes.DATE },
    dtCreatedOn: { type: DataTypes.DATE },
    dtStatusUpdateDate: { type: DataTypes.DATE },
    dtUpdatedOn: { type: DataTypes.DATE },
    iMWS_DataCopyStatus: { type: DataTypes.TINYINT },
    dtMWS_LastCopyStartTime: { type: DataTypes.DATE },
    dtMWS_LastCopyEndTime: { type: DataTypes.DATE },
    iDataCopyStatus: { type: DataTypes.TINYINT },
    dtLastCopyStartTime: { type: DataTypes.DATE },
    dtLastCopyEndTime: { type: DataTypes.DATE },
    iInitialDataCopyStatus: { type: DataTypes.TINYINT },
    dtLastInitialDataCopyStartTime: { type: DataTypes.DATE },
    dtLastInitialDataCopyEndTime: { type: DataTypes.DATE },
    iCurrentMonthArchiveStatus: { type: DataTypes.TINYINT },
    isMwsUser: { type: DataTypes.TINYINT },
    isBrandAnalyticsLostAccess: { type: DataTypes.TINYINT },
    isFinanceLostAccess: { type: DataTypes.TINYINT },
    HideFromMWSPlatform: { type: DataTypes.TINYINT },
    isMwsInitialReportDataPulled: { type: DataTypes.TINYINT },
    isMissingAsinsDataPulled: { type: DataTypes.TINYINT },
    iRunningInitialPull: { type: DataTypes.TINYINT },
    isMwsInventoryInitialDataPulled: { type: DataTypes.TINYINT },
    initialPullAfterLostAccess: { type: DataTypes.TINYINT },
    AmazonMarketplaceId: { type: DataTypes.STRING(100) },
    HasSellerSuspendedListings: { type: DataTypes.INTEGER },
    DefaultCountryCode: { type: DataTypes.STRING(100) },
    DomainName: { type: DataTypes.STRING(150) },
    SalesChannel: { type: DataTypes.STRING(150) },
    DefaultCurrencyCode: { type: DataTypes.STRING(150) },
    DefaultLanguageCode: { type: DataTypes.STRING(100) },
    dtMwsActivatedOn: { type: DataTypes.DATE },
    dtMWSDataPurgeDate: { type: DataTypes.DATE },
    dtMwsDataLastUpdatedOn: { type: DataTypes.DATE },
    dateFromToPullMwsData: { type: DataTypes.DATE },
    dtInventoryDataPulled: { type: DataTypes.DATE },
    isOrderMetricInitialPullVerified: { type: DataTypes.TINYINT },
    isOrderInitialPullVerified: { type: DataTypes.TINYINT },
    iDSPDataCopyStatus: { type: DataTypes.TINYINT },
    dtDSPLastCopyStartTime: { type: DataTypes.DATE },
    dtDSPLastCopyEndTime: { type: DataTypes.DATE },
    isDSPInitialReportDataPulled: { type: DataTypes.TINYINT },
    iRunningDspPull: { type: DataTypes.TINYINT },
    iPriorityFlag: { type: DataTypes.TINYINT },
    priorityFlagUpdatedOn: { type: DataTypes.DATE },
    iMWS_CurrentMonthArchiveStatus: { type: DataTypes.TINYINT },
    isLargeMwsDataMerchant: { type: DataTypes.TINYINT },
    dtLatestRecordDate: { type: DataTypes.DATE },
    dtMWSLatestRecordDate: { type: DataTypes.DATE },
    accessDate: { type: DataTypes.DATE },
    iDataOverwriteFlag: { type: DataTypes.TINYINT },
    isAnalyticsInitialPull: { type: DataTypes.TINYINT },
    isCustomInitialPull: { type: DataTypes.TINYINT },
    isSpApiBackfillPull: { type: DataTypes.TINYINT },
    dtBlankRecordUpdateDate: { type: DataTypes.DATE },
    iBlankBuyerEmailStatus: { type: DataTypes.TINYINT },
    dtForecastLatestDate: { type: DataTypes.DATE },
    iSpApiArchiveStatus: { type: DataTypes.TINYINT },
    dtSpApiLastArchiveStartTime: { type: DataTypes.DATE },
    dtSpApiLastArchiveEndTime: { type: DataTypes.DATE },
    iDeleteSpApiArchiveStatus: { type: DataTypes.TINYINT },
    dtDeleteSpApiArchiveStartTime: { type: DataTypes.DATE },
    dtDeleteSpApiArchiveEndTime: { type: DataTypes.DATE },
    iArchiveStatus: { type: DataTypes.TINYINT },
    dtLastArchiveStartTime: { type: DataTypes.DATE },
    dtLastArchiveEndTime: { type: DataTypes.DATE },
    iDeleteArchiveStatus: { type: DataTypes.TINYINT },
    dtDeleteArchiveStartTime: { type: DataTypes.DATE },
    dtDeleteArchiveEndTime: { type: DataTypes.DATE },
    iCustomUpdateStatus: { type: DataTypes.TINYINT },
    iBrandReportEnabled: { type: DataTypes.SMALLINT },
    isLargeAdvertiser: { type: DataTypes.TINYINT },
    dtCustomUpdateStartTime: { type: DataTypes.DATE },
    dtCustomUpdateEndTime: { type: DataTypes.DATE },
    dtUpdateDspAdvertisers: { type: DataTypes.DATE }
};

const modelOptions = {
    tableName: table,
    timestamps: false
};

// Lazy load model (called at runtime, not module load)
function getModel() {
    const currentUserId = getCurrentUserId();
    
    // Clear cache if database context changed
    if (cachedUserId !== currentUserId) {
        cachedModel = null;
        cachedUserId = currentUserId;
    }
    
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, modelDefinition, modelOptions);
    }
    
    return makeReadOnly(cachedModel);
}

module.exports = getModel();

// Attach read-only helper methods for cron needs
function getBoundModel() {
    // Get the lazy-loaded model bound to current tenant
    return getModel();
}

async function getProfileDetailsByID(idSellerAccount, key = 'ID') {
	const BoundSeller = getBoundModel();
	const column = String(key) === 'AmazonSellerID' ? 'AmazonSellerID' : 'ID';
	const value = column === 'ID' ? Number(idSellerAccount) : String(idSellerAccount);
	const s = await BoundSeller.findOne({ where: { [column]: value } });
	if (!s) return null;
	let mp = null;
	const mapping = await SellerMarketplacesMapping.findOne({ where: { SellerId: s.ID } }).catch(() => null);
	if (mapping) {
		mp = await Marketplace.findOne({ where: { ID: mapping.MarketId } }).catch(() => null);
	}
	if (!mp && s.MarketPlaceID) {
		mp = await Marketplace.findOne({ where: { ID: s.MarketPlaceID } }).catch(() => null);
	}
	const la = await MwsOauthToken.findOne({ where: { AmazonSellerID: s.AmazonSellerID } }).catch(() => null);
	const ma = await MwsAccessKeys.findOne({ where: { MerchantRegion: s.MerchantRegion } }).catch(() => null);
	return {
		idSellerAccount: s.ID,
		SellerName: s.Name,
		MerchantRegion: s.MerchantRegion,
		AmazonSellerID: s.AmazonSellerID,
		ProfileId: s.ProfileId,
		idUserAccount: s.idUserAccount,
		MerchantType: s.MerchantType,
		IsActive: s.IsActive,
		isMwsUser: s.isMwsUser,
		idMarketPlaceAccount: mp ? mp.ID : null,
		MarketPlaceName: mp ? mp.Name : null,
		CountryCode: mp ? mp.CountryCode : null,
		AmazonMarketplaceId: mp ? mp.AmazonMarketplaceId : (s.AmazonMarketplaceId || null),
		CurrencyCode: mp ? mp.CurrencyCode : null,
		iPriorityFlag: s.iPriorityFlag,
		dtMwsActivatedOn: s.dtMwsActivatedOn,
		isSpApiBackfillPull: s.isSpApiBackfillPull,
		pull60DaysReportFlag: s.pull60DaysReportFlag,
		isMwsInitialReportDataPulled: s.isMwsInitialPullVerified,
		dateFromToPullMwsData: s.dateFromToPullMwsData,
		iRunningInitialPull: s.iRunningInitialPull,
		iLostAccess: la ? la.iLostAccess : null,
		auth_token: la ? la.auth_token : null,
		developerId: ma ? ma.developerId : null,
	};
}

async function getProfileDetailsByAmazonSellerID(amazonSellerID) {
    const BoundSeller = getBoundModel();
    const s = await BoundSeller.findOne({ where: { AmazonSellerID: amazonSellerID } });
    if (!s) return null;
    return getProfileDetailsByID(s.ID);
}

async function getSellersProfilesForCronAdvanced({ idSellerAccount = 0, pullAll = 0, AmazonSellerID = '', marketplacename = '', marketplaceAry = [], isCustomPull = 0 } = {}) {
    const where = { isMwsUser: 1 };
    if (idSellerAccount > 0) where.ID = Number(idSellerAccount);
    if (AmazonSellerID) where.AmazonSellerID = AmazonSellerID;
    if (isCustomPull === 1) where.isCustomInitialPull = 1;

    const order = [['dtMwsActivatedOn', 'ASC']];

    const BoundSeller = getBoundModel();
    const sellers = await BoundSeller.findAll({ where, order });

    const results = [];
    for (const s of sellers) {
        let mp = null;
        const mapping = await SellerMarketplacesMapping.findOne({ where: { SellerId: s.ID } }).catch(() => null);
        if (mapping) {
            mp = await Marketplace.findOne({ where: { ID: mapping.MarketId } }).catch(() => null);
        }
        if (!mp && s.MarketPlaceID) {
            mp = await Marketplace.findOne({ where: { ID: s.MarketPlaceID } }).catch(() => null);
        }
        // Optional marketplace filters
        if (marketplacename && (!mp || mp.Name !== marketplacename)) continue;
        if (Array.isArray(marketplaceAry) && marketplaceAry.length && (!mp || !marketplaceAry.map(Number).includes(Number(mp.ID)))) continue;

        const row = {
            idSellerAccount: s.ID,
            SellerName: s.Name,
            MerchantRegion: s.MerchantRegion,
            AmazonSellerID: s.AmazonSellerID,
            ProfileId: s.ProfileId,
            IsActive: s.IsActive,
            isMwsUser: s.isMwsUser,
            MarketPlaceID: s.MarketPlaceID,
            idUserAccount: s.idUserAccount,
            dtMwsActivatedOn: s.dtMwsActivatedOn,
            MerchantType: s.MerchantType,
            isSpApiBackfillPull: s.isSpApiBackfillPull,
            pull60DaysReportFlag: s.pull60DaysReportFlag,
            isMwsInitialPullVerified: s.isOrderInitialPullVerified,
            dateFromToPullMwsData: s.dateFromToPullMwsData,
            AgencyName: s.AgencyName,
            idMarketPlaceAccount: mp ? mp.ID : null,
            MarketPlaceName: mp ? mp.Name : null,
            CountryCode: mp ? mp.CountryCode : null,
            AmazonMarketplaceId: mp ? mp.AmazonMarketplaceId : (s.AmazonMarketplaceId || null),
        };
        results.push(row);
    }

    if (pullAll === 0) {
        const seen = new Set();
        return results.filter(r => { if (seen.has(r.AmazonSellerID)) return false; seen.add(r.AmazonSellerID); return true; });
    }
    return results;
}

module.exports.getProfileDetailsByID = getProfileDetailsByID;
module.exports.getProfileDetailsByAmazonSellerID = getProfileDetailsByAmazonSellerID;
module.exports.getSellersProfilesForCronAdvanced = getSellersProfilesForCronAdvanced;

