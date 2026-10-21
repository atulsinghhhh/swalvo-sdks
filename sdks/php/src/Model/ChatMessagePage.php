<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** Cursor-paginated history. TS: `ChatMessagePage`. */
final class ChatMessagePage extends Model
{
    /** @var list<ChatMessage> */
    public readonly array $data;
    public readonly ?string $nextCursor;
    public readonly ?string $previousCursor;
    public readonly bool $hasMore;

    protected function hydrate(array $data): void
    {
        $this->data = ChatMessage::listFrom($data['data'] ?? null);
        $this->nextCursor = self::nstr($data, 'nextCursor');
        $this->previousCursor = self::nstr($data, 'previousCursor');
        $this->hasMore = self::bool($data, 'hasMore');
    }
}
