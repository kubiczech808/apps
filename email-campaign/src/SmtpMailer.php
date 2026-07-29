<?php

final class SmtpMailer
{
    public function __construct(private array $config)
    {
    }

    public function send(string $to, string $subject, string $html, array $vars = [], array $extraHeaders = []): void
    {
        $fromEmail = $this->config['from_email'];
        $fromName = $this->config['from_name'];
        $html = $this->personalize($html, $vars);
        $subject = $this->personalize($subject, $vars);
        $inlineImages = [];
        $html = $this->extractInlineDataImages($html, $inlineImages);
        $boundary = 'b' . bin2hex(random_bytes(12));
        $relatedBoundary = 'r' . bin2hex(random_bytes(12));
        $headers = [
            'From: ' . $this->formatAddress($fromEmail, $fromName),
            'To: ' . $to,
            'Subject: ' . $this->encodeHeader($subject),
            'MIME-Version: 1.0',
            'Content-Type: ' . ($inlineImages ? 'multipart/related; boundary="' . $relatedBoundary . '"' : 'multipart/alternative; boundary="' . $boundary . '"'),
            'Date: ' . date(DATE_RFC2822),
        ];
        foreach ($extraHeaders as $header) {
            $header = trim((string)$header);
            if ($header !== '' && preg_match('/^[A-Za-z0-9-]+:\s*[^\r\n]+$/', $header)) {
                $headers[] = $header;
            }
        }
        $plain = trim(html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />'], "\n", $html)), ENT_QUOTES, 'UTF-8'));
        $alternative = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n$plain\r\n";
        $alternative .= "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n$html\r\n--$boundary--\r\n";
        if ($inlineImages) {
            $body = "--$relatedBoundary\r\nContent-Type: multipart/alternative; boundary=\"$boundary\"\r\n\r\n$alternative";
            foreach ($inlineImages as $image) {
                $body .= "\r\n--$relatedBoundary\r\n";
                $body .= 'Content-Type: ' . $image['mime'] . '; name="' . $image['filename'] . "\"\r\n";
                $body .= "Content-Transfer-Encoding: base64\r\n";
                $body .= 'Content-ID: <' . $image['cid'] . ">\r\n";
                $body .= 'Content-Disposition: inline; filename="' . $image['filename'] . "\"\r\n\r\n";
                $body .= $image['data'] . "\r\n";
            }
            $body .= "--$relatedBoundary--\r\n";
        } else {
            $body = $alternative;
        }
        $message = implode("\r\n", $headers) . "\r\n\r\n" . $body;

        $socket = $this->connectAndAuthenticate();
        $this->cmd($socket, 'MAIL FROM:<' . $fromEmail . '>', [250]);
        $this->cmd($socket, 'RCPT TO:<' . $to . '>', [250, 251]);
        $this->cmd($socket, 'DATA', [354]);
        $this->writeData($socket, $message);
        $this->cmd($socket, 'QUIT', [221]);
        fclose($socket);
    }

    public function testConnection(): void
    {
        $socket = $this->connectAndAuthenticate();
        $this->cmd($socket, 'QUIT', [221]);
        fclose($socket);
    }

    /**
     * Chybejici nebo neplatne nastaveni musi rict, co presne doplnit. Bez teto kontroly
     * skonci prazdny host az v DNS jako "getaddrinfo for  failed", z ceho uzivatel nepozna,
     * ze mu jen chybi vyplneny SMTP server.
     */
    private function assertSmtpConfigured(array $smtp): void
    {
        $missing = [];
        if (trim((string)($smtp['host'] ?? '')) === '') {
            $missing[] = 'SMTP server';
        }
        if ((int)($smtp['port'] ?? 0) <= 0) {
            $missing[] = 'port';
        }
        if (trim((string)($smtp['username'] ?? '')) === '') {
            $missing[] = 'uzivatelske jmeno';
        }
        if (trim((string)($smtp['password'] ?? '')) === '') {
            $missing[] = 'heslo';
        }
        if ($missing) {
            throw new RuntimeException(
                'Odesilani emailu neni nastavene: chybi ' . implode(', ', $missing)
                . '. Vypln to v Konfigurace -> Odesilani e-mailu (SMTP) a uloz; pak zkus test znovu.'
            );
        }
        if (trim((string)$smtp['host']) === 'smtp.example.com') {
            throw new RuntimeException(
                'SMTP server je jeste na vzorove hodnote smtp.example.com. Zadej v Konfigurace -> Odesilani e-mailu (SMTP)'
                . ' skutecny server od poskytovatele hostingu nebo mailu.'
            );
        }
    }

    private function connectAndAuthenticate()
    {
        $smtp = $this->config['smtp'];
        $this->assertSmtpConfigured($smtp);
        $host = trim((string)$smtp['host']);
        $port = (int)$smtp['port'];
        $scheme = ($smtp['encryption'] ?? '') === 'ssl' ? 'ssl://' : '';
        $socket = stream_socket_client($scheme . $host . ':' . $port, $errno, $errstr, 30);
        if (!$socket) {
            throw new RuntimeException($this->connectionErrorMessage($host, $port, (string)$errstr));
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

    /**
     * Prelozi technickou chybu spojeni na to, co ma uzivatel zmenit.
     */
    private function connectionErrorMessage(string $host, int $port, string $error): string
    {
        $where = $host . ':' . $port;
        if (stripos($error, 'getaddrinfo') !== false || stripos($error, 'name does not resolve') !== false || stripos($error, 'name or service not known') !== false) {
            return 'SMTP server ' . $where . ' neexistuje nebo se nepodarilo prelozit jeho jmeno.'
                . ' Zkontroluj preklep v adrese serveru v Konfigurace -> Odesilani e-mailu (SMTP).'
                . ' Detail: ' . $error;
        }
        if (stripos($error, 'refused') !== false) {
            return 'SMTP server ' . $where . ' spojeni odmitl. Nejcasteji je spatny port nebo typ sifrovani'
                . ' (587 = TLS, 465 = SSL). Uprav to v Konfigurace -> Odesilani e-mailu (SMTP). Detail: ' . $error;
        }
        if (stripos($error, 'timed out') !== false || stripos($error, 'timeout') !== false) {
            return 'SMTP server ' . $where . ' neodpovedel v limitu. Bud je nedostupny, nebo hosting odchozi spojeni na tento port blokuje.'
                . ' Detail: ' . $error;
        }
        return 'Spojeni na SMTP server ' . $where . ' se nepodarilo. Detail: ' . $error;
    }

    private function personalize(string $text, array $vars): string
    {
        return strtr($text, [
            '{{email}}' => $vars['email'] ?? '',
            '{{name}}' => $vars['name'] ?? '',
        ]);
    }

    private function extractInlineDataImages(string $html, array &$images): string
    {
        return preg_replace_callback('#<img\b[^>]*\bsrc=(["\'])(data:image/(png|jpe?g|gif|webp)(?:;[^,]*)?;base64,([^"\']+))\1[^>]*>#i', function (array $match) use (&$images): string {
            $base64 = preg_replace('/\s+/', '', $match[4]) ?? '';
            $binary = base64_decode($base64, true);
            if ($binary === false || $binary === '') {
                return $match[0];
            }
            $type = strtolower($match[3]);
            $mime = $type === 'jpg' ? 'image/jpeg' : 'image/' . $type;
            $extension = $type === 'jpeg' ? 'jpg' : $type;
            $index = count($images) + 1;
            $cid = 'img' . $index . '.' . bin2hex(random_bytes(8)) . '@email-campaign';
            $images[] = [
                'cid' => $cid,
                'mime' => $mime,
                'filename' => 'image-' . $index . '.' . $extension,
                'data' => chunk_split(base64_encode($binary), 76, "\r\n"),
            ];
            return str_replace($match[2], 'cid:' . $cid, $match[0]);
        }, $html) ?? $html;
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

    private function writeData($socket, string $message): void
    {
        $message = $this->normalizeCrlf($message);
        $message = preg_replace('/^\./m', '..', $message) ?? $message;
        fwrite($socket, rtrim($message, "\r\n") . "\r\n.\r\n");
        $this->expect($socket, [250]);
    }

    private function normalizeCrlf(string $text): string
    {
        return preg_replace("/\r\n|\r|\n/", "\r\n", $text) ?? $text;
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
