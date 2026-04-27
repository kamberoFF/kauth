import dotenv from 'dotenv';

dotenv.config();

interface Config {
 port: number;
 bun_env: string;
 database_url: string;
}

const config: Config = {
 port: Number(process.env.PORT) || 6767,
 bun_env: process.env.BUN_ENV || 'dev',
 database_url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/kauth?schema=public'
};

export default config;