/** Loaded before tests so importing env/pool does not crash without a real .env */
process.env.DATABASE_URL ||= "postgresql://recycling_user:change_me_local_only@localhost:5432/recycling_db";
process.env.JWT_SECRET ||= "test_jwt_secret_for_unit_tests_only";
process.env.HEDERA_CHAIN_ID ||= "296";
