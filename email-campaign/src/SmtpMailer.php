<?php

final class SmtpMailer
{
    public function __construct(private array $config)
    {
    }

    public function send(string $to, string $subject, string $html, array $vars = []): void
    {
        $fromEmail = $this->config['from_email'];
        $fromName = $this->config['from_name'];
        $html = $this->personalize($html, $vars);
        $subject = $this->personalize($subject, $vars);
        $boundary = 'b' . bin2hex(random_bytes(12));
        $headers = [
            'From: ' . $this->formatAddress($fromEmail, $fromName),
            'To: ' . $to,
            'Subject: ' . $this->encodeHeader($subject),
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
            'Date: ' . date(DATE_RFC2822),
        ];
        $plain = trim(html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />'], "\n", $html)), ENT_QUOTES, 'UTF-8'));
        $body = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n$plain\r\n";
        $body .= "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n$html\r\n--$boundary--\r\n";
        $message = implode("\r\n", $headers) . "\r\n\r\n" . $body;

        $socket = $this->connectAndAuthenticate();
        $this->cmd($socket, 'MAIL FROM:<' . $fromEmail . '>', [250]);
        $this->cmd($socket, 'RCPT TO:<' . $to . '>', [250, 251]);
        $this->cmd($socket, 'DATA', [354]);
        $this->cmd($socket, $message . "\r\n.", [250]);
        $this->cmd($socket, 'QUIT', [221]);
        fclose($socket);
    }

    public function testConnection(): void
    {
        $socket = $this->connectAndAuthenticate();
        $this->cmd($socket, 'QUIT', [221]);
        fclose($socket);
    }

    private function connectAndAuthenticate()
    {
        $smtp = $this->config['smtp'];
        $host = $smtp['host'];
        $port = (int)$smtp['port'];
        $scheme = ($smtp['encryption'] ?? '') === 'ssl' ? 'ssl://' : '';
        $socket = stream_socket_client($scheme . $host . ':' . $port, $errno, $errstr, 30);
        if (!$socket) {
            throw new RuntimeException("SMTP connection failed: $errstr");
        }

        $this->expect($socket, [220]);
        $this->cmd($socket, 'EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'), [250]);
        if (($smtp['encryption'] ?? '') === 'tls') {
            $this->cmd($socket, 'STARTTLS', [220]);
            stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
            $this->cmd($socket, 'EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'), [250]);
        }
        $this->cmd($socket, 'AUTH LOGIN', [334]);
        $this->cmd($socket, base64_encode($smtp['username']), [334]);
        $this->cmd($socket, base64_encode($smtp['password']), [235]);

        return $socket;
    }

    private function personalize(string $text, array $vars): string
    {
        return strtr($text, [
            '{{email}}' => $vars['email'] ?? '',
            '{{name}}' => $vars['name'] ?? '',
        ]);
    }

    private function formatAddress(string $email, string $name): string
    {
        return $this->encodeHeader($name) . " <$email>";
    }

    private function encodeHeader(string $value): string
    {
        return '=?UTF-8?B?' . base64_encode($value) . '?=';
    }

    private function cmd($socket, string $command, array $codes): void
    {
        fwrite($socket, $command . "\r\n");
        $this->expect($socket, $codes);
    }

    private function expect($socket, array $codes): void
    {
        $response = '';
        while (($line = fgets($socket, 515)) !== false) {
            $response .= $line;
            if (isset($line[3]) && $line[3] === ' ') {
                break;
            }
        }
        $code = (int)substr($response, 0, 3);
        if (!in_array($code, $codes, true)) {
            throw new RuntimeException(trim($response));
        }
    }
}
