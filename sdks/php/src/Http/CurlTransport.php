<?php

declare(strict_types=1);

namespace Swalvo\Http;

/**
 * The default transport: ext-curl, one handle per request, nothing kept between calls.
 *
 * Redirects are not followed (a redirect comes back as a non-2xx response), so the bearer token is only
 * ever sent to the configured base URL. Only http and https are allowed.
 */
final class CurlTransport implements TransportInterface
{
    public function send(Request $request): Response
    {
        $handle = curl_init();
        if ($handle === false) {
            throw new TransportException('Could not initialise a curl handle');
        }

        $headerLines = [];
        foreach ($request->headers() as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }
        // No `Expect: 100-continue` round trip on larger bodies.
        $headerLines[] = 'Expect:';

        $responseHeaders = [];
        $timeoutMs = max(1, (int) round($request->timeout * 1000));

        $options = [
            CURLOPT_URL => $request->url,
            CURLOPT_CUSTOMREQUEST => $request->method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => $timeoutMs,
            // Required for sub-second timeouts on some platforms.
            CURLOPT_NOSIGNAL => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $trimmed = trim($line);
                if (stripos($trimmed, 'HTTP/') === 0) {
                    // A new status line (after a 100 Continue, say) starts a fresh header set.
                    $responseHeaders = [];
                } elseif ($trimmed !== '' && str_contains($trimmed, ':')) {
                    [$name, $value] = explode(':', $trimmed, 2);
                    $responseHeaders[strtolower(trim($name))] = trim($value);
                }

                return strlen($line);
            },
        ];

        if ($request->body !== null) {
            $options[CURLOPT_POSTFIELDS] = $request->body;
        } elseif ($request->method === 'POST' || $request->method === 'PATCH') {
            // Send `Content-Length: 0`, as fetch() does for a bodyless POST.
            $options[CURLOPT_POSTFIELDS] = '';
        }

        curl_setopt_array($handle, $options);

        $body = curl_exec($handle);
        $errno = curl_errno($handle);
        $error = curl_error($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($body === false || $errno !== 0) {
            throw new TransportException(
                $error !== '' ? $error : 'curl request failed',
                $errno === CURLE_OPERATION_TIMEDOUT,
            );
        }

        return new Response($status, $responseHeaders, (string) $body);
    }
}
