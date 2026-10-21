package io.swalvo.rtc.call

// Deprecated names from before the Swalvo rename. Manifest entries must use the
// new class names (io.swalvo.rtc.call.SwalvoCallService / SwalvoConnectionService).

@Deprecated("Renamed to SwalvoCallService", ReplaceWith("SwalvoCallService", "io.swalvo.rtc.call.SwalvoCallService"))
public typealias LivqenoCallService = SwalvoCallService

@Deprecated("Renamed to SwalvoConnectionService", ReplaceWith("SwalvoConnectionService", "io.swalvo.rtc.call.SwalvoConnectionService"))
public typealias LivqenoConnectionService = SwalvoConnectionService

@Deprecated("Renamed to SwalvoConnection", ReplaceWith("SwalvoConnection", "io.swalvo.rtc.call.SwalvoConnection"))
public typealias LivqenoConnection = SwalvoConnection

@Deprecated("Renamed to SwalvoCallManager", ReplaceWith("SwalvoCallManager", "io.swalvo.rtc.call.SwalvoCallManager"))
public typealias LivqenoCallManager = SwalvoCallManager
