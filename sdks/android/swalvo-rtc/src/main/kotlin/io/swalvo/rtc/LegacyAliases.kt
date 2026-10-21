package io.swalvo.rtc

// Deprecated names from before the Swalvo rename. Same types, so existing code
// keeps compiling (with a warning) after changing `io.livqeno.rtc` imports to
// `io.swalvo.rtc`.

@Deprecated("Renamed to SwalvoClient", ReplaceWith("SwalvoClient", "io.swalvo.rtc.SwalvoClient"))
public typealias RavenClient = SwalvoClient

@Deprecated("Renamed to SwalvoClientOptions", ReplaceWith("SwalvoClientOptions", "io.swalvo.rtc.SwalvoClientOptions"))
public typealias RavenClientOptions = SwalvoClientOptions
