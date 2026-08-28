<?php

return [
    'app_password_hash' => '',
    'admin_email' => 'admin@osobnizkusenosti.cz',
    'cron_token' => '',
    'campaign_cron_interval_minutes' => 5,
    'campaign_send_delay_seconds' => 2,
    'from_email' => 'newsletter@osobnizkusenosti.cz',
    'from_name' => 'Osobni zkusenosti',
    'smtp' => [
        'host' => 'smtp.example.com',
        'port' => 587,
        'username' => 'newsletter@osobnizkusenosti.cz',
        'password' => 'smtp-password',
        'encryption' => 'tls',
    ],
    'google' => [
        'client_id' => '',
        'client_secret' => '',
        'auth_secret' => '',
        'redirect_uri' => 'https://www.btc-dca.com/app/auth/google/callback',
        'app_url' => 'https://www.btc-dca.com',
    ],
    'stripe' => [
        'secret_key' => '',
        'publishable_key' => '',
        'price_id' => '',
    ],
    'ai' => [
        'openai_api_key' => '',
        'openai_model' => 'gpt-4.1',
        // Bezpecny vychozi strop pro pravidelny AI research. Hodnoty lze navysit
        // pres deployment secrets az po overeni nakladu a chovani modelu.
        'openai_research_rpm_budget' => 10,
        'openai_research_daily_request_budget' => 120,
        'openai_research_daily_seed_budget' => 0,
        'openai_research_requests_per_seed' => 2,
        'gemini_api_key' => '',
        'gemini_model' => 'gemini-3-flash-preview',
        'gemini_research_model' => 'gemini-3-flash-preview',
        'gemini_research_rpm_budget' => 18,
        'gemini_research_daily_request_budget' => 0, // 0 = vychozi strop podle free tieru (200)
        'gemini_research_daily_seed_budget' => 0,
        'gemini_research_requests_per_seed' => 2,
        'gemini_research_validation_attempts' => 1,
    ],
    'database' => [
        'driver' => 'mysql',
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'database_name',
        'username' => 'database_user',
        'password' => 'database_password',
        'charset' => 'utf8mb4',
    ],
];
