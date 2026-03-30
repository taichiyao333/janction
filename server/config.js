require('dotenv').config();
const path = require('path');

module.exports = {
    port: parseInt(process.env.PORT) || 3000,
    adminPort: parseInt(process.env.ADMIN_PORT) || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',

    jwt: {
        secret: (() => {
            if (!process.env.JWT_SECRET) {
                if (process.env.NODE_ENV === 'production') {
                    throw new Error('JWT_SECRET must be set in production!');
                }
                console.warn('⚠️  JWT_SECRET not set, using insecure default (dev only)');
                return 'dev-only-insecure-fallback-secret';
            }
            return process.env.JWT_SECRET;
        })(),
        expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    },

    storage: {
        basePath: process.env.STORAGE_PATH || 'C:/janction-main/data',
        dbPath: process.env.DB_PATH || 'C:/janction-main/data/db/platform.db',
        get usersPath() { return path.join(this.basePath, 'users'); },
        get sharedPath() { return path.join(this.basePath, 'shared'); },
    },

    gpu: {
        pollInterval: parseInt(process.env.GPU_POLL_INTERVAL) || 3600000, // 1 hour
        tempAlertThreshold: parseInt(process.env.TEMP_ALERT_THRESHOLD) || 85,
    },

    admin: {
        email: process.env.ADMIN_EMAIL || 'admin@example.com',
        password: process.env.ADMIN_PASSWORD || 'admin123',
    },

    rateLimit: {
        api: { windowMs: 60 * 1000, max: 100 },
        login: { windowMs: 60 * 1000, max: 5 },
        upload: { windowMs: 60 * 1000, max: 10 },
    },

    stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY || '',
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
        publishableKey: process.env.STRIPE_PK || '',
    },

    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    providerPayoutRate: parseFloat(process.env.PROVIDER_PAYOUT_RATE) || 0.8,
};

