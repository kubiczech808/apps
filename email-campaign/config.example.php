<?php

return [
    'app_password_hash' => '',
    'cron_token' => '',
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
