package swalvo

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// ChatResource is Swalvo Chat, server-side.
//
// CreateToken is the method that matters: your backend authenticates the
// user its own way, then asks Swalvo for a short-lived token scoped to that
// one user, and only that token ever reaches the browser. The project API key
// never does.
type ChatResource struct{ http *httpClient }

type createChatTokenBody struct {
	UserID        string      `json:"userId"`
	Conversations []string    `json:"conversations,omitempty"`
	Scopes        []ChatScope `json:"scopes,omitempty"`
	TTLSeconds    int         `json:"ttlSeconds,omitempty"`
}

// CreateToken mints a browser-safe chat token. Scopes can only narrow what
// the user's role already allows. POST /v1/chat/tokens
func (r *ChatResource) CreateToken(ctx context.Context, params CreateChatTokenParams) (*IssuedChatToken, error) {
	body := createChatTokenBody{
		UserID:        params.UserID,
		Conversations: params.Conversations,
		Scopes:        params.Scopes,
		TTLSeconds:    params.ExpiresIn,
	}
	var out IssuedChatToken
	if err := r.http.request(ctx, "/v1/chat/tokens", requestOptions{method: http.MethodPost, body: body}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateConversation creates a conversation. Set RoomID to attach it to an
// RTC room. List its Members, or it is unusable by every chat token.
// POST /v1/chat/conversations
func (r *ChatResource) CreateConversation(ctx context.Context, params CreateConversationParams) (*ChatConversation, error) {
	var out ChatConversation
	if err := r.http.request(ctx, "/v1/chat/conversations", requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListConversations returns every conversation in the project, or with
// UserID only those that user actively belongs to.
// GET /v1/chat/conversations?userId=&includeArchived=
func (r *ChatResource) ListConversations(ctx context.Context, params *ListConversationsParams) ([]ChatConversation, error) {
	q := url.Values{}
	if params != nil {
		setIf(q, "userId", params.UserID)
		if params.IncludeArchived != nil {
			q.Set("includeArchived", strconv.FormatBool(*params.IncludeArchived))
		}
	}
	var out []ChatConversation
	if err := r.http.request(ctx, "/v1/chat/conversations", requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetConversation takes a conv_... id, the conversation name, or an attached
// RTC room id. GET /v1/chat/conversations/{room}
func (r *ChatResource) GetConversation(ctx context.Context, room string) (*ChatConversation, error) {
	var out ChatConversation
	if err := r.http.request(ctx, p("/v1/chat/conversations/%s", room), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddMember adds a user to a conversation. POST /v1/chat/conversations/{room}/members
func (r *ChatResource) AddMember(ctx context.Context, room string, params AddMemberParams) (*ChatMember, error) {
	var out ChatMember
	if err := r.http.request(ctx, p("/v1/chat/conversations/%s/members", room), requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveMember removes a user. DELETE /v1/chat/conversations/{room}/members/{userId}
func (r *ChatResource) RemoveMember(ctx context.Context, room, userID string) error {
	return r.http.request(ctx, p("/v1/chat/conversations/%s/members/%s", room, userID), requestOptions{method: http.MethodDelete}, nil)
}

// ListMembers returns a conversation's members. GET /v1/chat/conversations/{room}/members
func (r *ChatResource) ListMembers(ctx context.Context, room string) ([]ChatMember, error) {
	var out []ChatMember
	if err := r.http.request(ctx, p("/v1/chat/conversations/%s/members", room), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SendMessage posts a message as any user in the project, which is exactly
// why it's server-only. Type "system" exists here and nowhere else.
// POST /v1/chat/conversations/{room}/messages
func (r *ChatResource) SendMessage(ctx context.Context, room string, params SendChatMessageParams) (*ChatMessage, error) {
	var out ChatMessage
	if err := r.http.request(ctx, p("/v1/chat/conversations/%s/messages", room), requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListMessages returns cursor-paginated history. Use Before to page back.
// GET /v1/chat/conversations/{room}/messages?limit=&before=&after=&senderId=&includeDeleted=true
func (r *ChatResource) ListMessages(ctx context.Context, room string, params *ListChatMessagesParams) (*ChatMessagePage, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != 0 {
			q.Set("limit", strconv.Itoa(params.Limit))
		}
		setIf(q, "before", params.Before)
		setIf(q, "after", params.After)
		setIf(q, "senderId", params.SenderID)
		if params.IncludeDeleted {
			q.Set("includeDeleted", "true")
		}
	}
	var out ChatMessagePage
	if err := r.http.request(ctx, p("/v1/chat/conversations/%s/messages", room), requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteMessage soft-deletes a message: the row survives with a DeletedAt.
// DELETE /v1/chat/messages/{messageId}
func (r *ChatResource) DeleteMessage(ctx context.Context, messageID string) (*ChatMessage, error) {
	var out ChatMessage
	if err := r.http.request(ctx, p("/v1/chat/messages/%s", messageID), requestOptions{method: http.MethodDelete}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
