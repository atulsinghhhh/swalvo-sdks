# libwebrtc is reached over JNI; keep its Java surface.
-keep class org.webrtc.** { *; }
# kotlinx.serialization generated serializers for the wire protocol.
-keepclassmembers class io.swalvo.rtc.internal.protocol.** { *** Companion; *** serializer(...); }
-keep,includedescriptorclasses class io.swalvo.rtc.internal.protocol.**$$serializer { *; }
