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
    'database' => [
        'driver' => 'sqlite',
        'path' => __DIR__ . '/storage/app.sqlite',
    ],
    // MySQL/MariaDB varianta:
    // 'database' => [
    //     'driver' => 'mysql',
    //     'host' => 'localhost',
    //     'port' => 3306,
    //     'name' => 'database_name',
    //     'username' => 'database_user',
    //     'password' => 'database_password',
    //     'charset' => 'utf8mb4',
    // ],
];
