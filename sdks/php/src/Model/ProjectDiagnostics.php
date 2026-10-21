<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ProjectDiagnostics`. Inline TS object shapes stay arrays here. */
final class ProjectDiagnostics extends Model
{
    /** @var array{id: string, name: string}|null */
    public readonly ?array $project;
    /** 'up' */
    public readonly string $api;
    /** 'ok' */
    public readonly string $authentication;
    /** @var array{signaling: 'up'|'down', sfu: 'up'|'down', turn: 'up'|'down'}|null */
    public readonly ?array $dependencies;
    /** @var array{active: int}|null */
    public readonly ?array $connections;

    protected function hydrate(array $data): void
    {
        $this->project = self::map($data, 'project');
        $this->api = self::str($data, 'api');
        $this->authentication = self::str($data, 'authentication');
        $this->dependencies = self::map($data, 'dependencies');
        $this->connections = self::map($data, 'connections');
    }
}
