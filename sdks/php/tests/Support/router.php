<?php

// Router for `php -S` in tests/LocalServerTest.php. Never part of the SDK.

declare(strict_types=1);

$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$headers = array_change_key_case(function_exists('getallheaders') ? getallheaders() : [], CASE_LOWER);
$body = (string) file_get_contents('php://input');

$echo = [
    'method' => $_SERVER['REQUEST_METHOD'],
    'path' => $path,
    'query' => $_SERVER['QUERY_STRING'] ?? '',
    'headers' => $headers,
    'body' => $body,
];

function respond(int $status, mixed $payload, array $extraHeaders = []): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    foreach ($extraHeaders as $name => $value) {
        header("{$name}: {$value}");
    }
    echo json_encode($payload);
}

// /flaky/{failures}/{status}: the first {failures} hits for a given x-test-key answer {status}, then 200.
if (preg_match('#^/flaky/(\d+)/(\d+)$#', $path, $m)) {
    $file = sys_get_temp_dir() . '/swalvo-flaky-' . md5($headers['x-test-key'] ?? $_SERVER['QUERY_STRING'] ?? 'default');
    $attempt = (int) @file_get_contents($file) + 1;
    file_put_contents($file, (string) $attempt);
    if ($attempt <= (int) $m[1]) {
        respond((int) $m[2], ['message' => 'transient failure', 'code' => 'RAVEN_TEST_FAILURE', 'attempt' => $attempt], ['x-request-id' => "req_attempt_{$attempt}"]);
    } else {
        respond(200, ['attempts' => $attempt]);
    }
    return true;
}

// /status/{code}: an API-shaped error.
if (preg_match('#^/status/(\d+)$#', $path, $m)) {
    respond((int) $m[1], ['statusCode' => (int) $m[1], 'code' => 'RAVEN_ROOM_NOT_FOUND', 'message' => 'Room not found'], ['x-request-id' => 'req_local_123']);
    return true;
}

// /html/{code}: a proxy page with no JSON body.
if (preg_match('#^/html/(\d+)$#', $path, $m)) {
    http_response_code((int) $m[1]);
    header('Content-Type: text/html');
    echo '<html><body>Bad Gateway</body></html>';
    return true;
}

if ($path === '/no-content') {
    http_response_code(204);
    return true;
}

// Everything else: a Room-shaped body that also echoes what arrived.
$decoded = json_decode($body, true);
respond(200, [
    'id' => 'room_local',
    'projectId' => 'proj_local',
    'name' => is_array($decoded) && isset($decoded['name']) ? $decoded['name'] : 'echo',
    'status' => 'ACTIVE',
    'createdAt' => '2026-10-03T00:00:00.000Z',
    'updatedAt' => '2026-10-03T00:00:00.000Z',
    '_echo' => $echo,
]);
return true;
