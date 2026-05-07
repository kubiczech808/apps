<?php

return [
    'app_password_hash' => '$2y$10$replace-with-password-hash',
    'cron_token' => 'replace-with-long-random-token',
    'from_email' => 'newsletter@osobnizkusenosti.cz',
    'from_name' => 'Osobni zkusenosti',
    'smtp' => [
        'host' => 'smtp.example.com',
        'port' => 587,
        'username' => 'newsletter@osobnizkusenosti.cz',
        'password' => 'smtp-password',
        'encryption' => 'tls',
    ],
    'database_path' => __DIR__ . '/storage/app.sqlite',
];
