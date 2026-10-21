package com.swalvo.server.model;

/**
 * Parameters for {@code liveStreams().ingress().create()}. Every field is optional.
 *
 * @param protocol defaults to RTMP. The key is the RTMP stream key or the WHIP bearer token.
 * @param identity must be a registered host of the stream. Defaults to the stream's HOST identity.
 * @param autoStart start a CREATED stream automatically when the encoder connects. Defaults to true.
 * @param reconnectWindowSec seconds the room stays joined after the encoder drops. Defaults to 60.
 */
public record CreateIngressParams(
        IngressProtocol protocol, String identity, Boolean autoStart, Integer reconnectWindowSec) {

    /** All API defaults: sends {@code {}}. */
    public static final CreateIngressParams DEFAULTS = new CreateIngressParams(null, null, null, null);

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private IngressProtocol protocol;
        private String identity;
        private Boolean autoStart;
        private Integer reconnectWindowSec;

        private Builder() {}

        public Builder protocol(IngressProtocol protocol) { this.protocol = protocol; return this; }
        public Builder identity(String identity) { this.identity = identity; return this; }
        public Builder autoStart(boolean value) { this.autoStart = value; return this; }
        public Builder reconnectWindowSec(Integer seconds) { this.reconnectWindowSec = seconds; return this; }

        public CreateIngressParams build() {
            return new CreateIngressParams(protocol, identity, autoStart, reconnectWindowSec);
        }
    }
}
