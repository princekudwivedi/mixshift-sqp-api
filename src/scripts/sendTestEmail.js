const { NotificationHelpers } = require('../helpers/sqp.helpers');
const logger = require('../utils/logger.utils');
const env  = require('../config/env.config');

(async () => {
	try {
		const args = process.argv.slice(2);
		// Usage: node src/scripts/sendTestEmail.js to=user@example.com subject="Test" body="Hello"
		const argMap = args.reduce((acc, cur) => {
			const [k, v] = cur.split('=');
			if (k) acc[k.replace(/^--?/, '')] = v || '';
			return acc;
		}, {});

		const toArg = argMap.to || '';
		const subjectArg = argMap.subject || 'SQP Test Email';
		const bodyArg = argMap.body || 'This is a test email from SQP system.';

		const to = toArg
			? toArg.split(',').map(s => s.trim()).filter(Boolean)
			: NotificationHelpers.parseList(env.NOTIFY_TO);
		const cc = NotificationHelpers.parseList(env.NOTIFY_CC);
		const bcc = NotificationHelpers.parseList(env.NOTIFY_BCC);

		if (!to || to.length === 0) {
			logger.warn('No recipients provided. Use to=email@example.com or set NOTIFY_TO');
			process.exitCode = 2;
			return;
		}

		const html = `<p>${bodyArg}</p><p>Time: ${dates.getDateTime()}</p>`;
		const ok = await NotificationHelpers.sendEmail({ subject: subjectArg, html, to, cc, bcc });
		if (ok) {
			logger.info({ to: to.join(','), subject: subjectArg }, 'Test email sent successfully');
			process.exit(0);
		} else {
			logger.error({ to: to.join(','), subject: subjectArg }, 'Test email failed');
			process.exit(1);
		}
	} catch (error) {
		logger.error({ error: error.message, stack: error.stack }, 'Test email script error');
		process.exit(1);
	}
})();


