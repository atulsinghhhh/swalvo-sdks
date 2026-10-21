<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `LiveStream`, plus the `delivery` view the API returns alongside it. */
final class LiveStream extends Model
{
    public readonly string $id;
    public readonly string $title;
    public readonly ?string $description;
    public readonly ?string $thumbnailUrl;
    public readonly ?string $category;
    /** @var list<string> */
    public readonly array $tags;
    public readonly ?string $language;
    /** PUBLIC | PRIVATE | AUTHENTICATED */
    public readonly string $visibility;
    /** @var array<string, mixed>|null */
    public readonly ?array $metadata;
    /** CREATED | STARTING | LIVE | ENDING | ENDED */
    public readonly string $status;
    /** @var list<LiveStreamHostView> */
    public readonly array $hosts;
    /** null means the SFU couldn't be reached, which is not the same as a genuine 0. */
    public readonly ?int $viewerCount;
    public readonly int $peakViewerCount;
    public readonly ?LiveStreamDeliveryView $delivery;
    public readonly ?string $conversationId;
    /** The chat message viewer reactions attach to. */
    public readonly ?string $chatRootMessageId;
    public readonly ?string $scheduledAt;
    public readonly ?string $startedAt;
    public readonly ?string $endedAt;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->title = self::str($data, 'title');
        $this->description = self::nstr($data, 'description');
        $this->thumbnailUrl = self::nstr($data, 'thumbnailUrl');
        $this->category = self::nstr($data, 'category');
        $this->tags = self::strList($data, 'tags');
        $this->language = self::nstr($data, 'language');
        $this->visibility = self::str($data, 'visibility');
        $this->metadata = self::map($data, 'metadata');
        $this->status = self::str($data, 'status');
        $this->hosts = LiveStreamHostView::listFrom($data['hosts'] ?? null);
        $this->viewerCount = self::nint($data, 'viewerCount');
        $this->peakViewerCount = self::int($data, 'peakViewerCount');
        $this->delivery = LiveStreamDeliveryView::fromNullable($data['delivery'] ?? null);
        $this->conversationId = self::nstr($data, 'conversationId');
        $this->chatRootMessageId = self::nstr($data, 'chatRootMessageId');
        $this->scheduledAt = self::nstr($data, 'scheduledAt');
        $this->startedAt = self::nstr($data, 'startedAt');
        $this->endedAt = self::nstr($data, 'endedAt');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
