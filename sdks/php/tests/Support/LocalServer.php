<?php

declare(strict_types=1);

namespace Swalvo\Tests\Support;

/** Runs `php -S 127.0.0.1:<free port> tests/Support/router.php` for the duration of the test run. */
final class LocalServer
{
    /** @var resource|null */
    private static $process = null;
    private static ?string $baseUrl = null;

    public static function baseUrl(): string
    {
        if (self::$baseUrl !== null) {
            return self::$baseUrl;
        }

        $port = self::freePort();
        $process = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__ . '/router.php'],
            [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        if (!is_resource($process)) {
            throw new \RuntimeException('Could not start php -S');
        }
        self::$process = $process;
        register_shutdown_function([self::class, 'stop']);

        $deadline = microtime(true) + 10;
        while (microtime(true) < $deadline) {
            $socket = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
            if ($socket !== false) {
                fclose($socket);

                return self::$baseUrl = "http://127.0.0.1:{$port}";
            }
            usleep(50_000);
        }

        self::stop();
        throw new \RuntimeException('php -S did not start listening in time');
    }

    public static function stop(): void
    {
        if (is_resource(self::$process)) {
            proc_terminate(self::$process);
            proc_close(self::$process);
        }
        self::$process = null;
        self::$baseUrl = null;
    }

    /** A port nothing listens on, for connection-refused tests. */
    public static function closedPort(): int
    {
        return self::freePort();
    }

    private static function freePort(): int
    {
        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if ($server === false) {
            throw new \RuntimeException("Could not reserve a port: {$errstr}");
        }
        $name = (string) stream_socket_get_name($server, false);
        fclose($server);

        return (int) substr($name, strrpos($name, ':') + 1);
    }
}
