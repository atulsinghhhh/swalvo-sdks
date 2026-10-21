'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DeviceKind, Room } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { ChevronIcon } from './icons';
import { supportsAudioOutputSelection, useMediaDeviceSelect } from './video-hooks';

const KIND_LABELS: Record<DeviceKind, string> = {
  videoinput: 'Camera',
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
};

export interface MediaDeviceMenuProps {
  /** One device kind… */
  kind?: DeviceKind;
  /** …or several, each as its own section (e.g. microphone + speaker). `audiooutput` is dropped where the browser can't select one. */
  kinds?: DeviceKind[];
  room?: Room;
  /** The trigger's accessible name. Default: "Choose camera" etc. */
  label?: string;
  /** Trigger content. Default: a chevron. */
  children?: ReactNode;
  onActiveDeviceChange?: (kind: DeviceKind, deviceId: string) => void;
  onError?: (error: Error) => void;
  className?: string;
}

/**
 * A button that opens a menu of devices to switch to — the chevron next
 * to a mic or camera toggle. Switching a live track is seamless (no
 * republish); picking while the track is off is remembered for when it
 * is turned on.
 *
 * Keyboard: Enter/Space/ArrowDown opens and focuses the active device;
 * arrows, Home and End move; Enter or Space picks; Escape closes and
 * returns focus to the button.
 */
export function MediaDeviceMenu({
  kind,
  kinds,
  room,
  label,
  children,
  onActiveDeviceChange,
  onError,
  className,
}: MediaDeviceMenuProps) {
  const requested = kinds ?? (kind ? [kind] : ['videoinput']);
  const sections = requested.filter((k) => k !== 'audiooutput' || supportsAudioOutputSelection());
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerLabel = label ?? `Choose ${sections.map((k) => KIND_LABELS[k].toLowerCase()).join(' and ')}`;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Focus the checked item (or the first) when the menu opens — and again
  // once the device list arrives, if focus has not moved into the menu yet
  // (enumerateDevices is async, so the first render may have no items).
  const focusInitialItem = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    const items = menuItems(menu);
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true');
    (checked ?? items[0])?.focus();
  }, []);
  useEffect(() => {
    if (open) focusInitialItem();
  }, [open, focusInitialItem]);

  // Close on a click outside.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: Event) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(index + 1);
      case 'ArrowUp':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(items.length - 1);
      case 'Escape':
        event.preventDefault();
        return close(true);
      case 'Tab':
        return close(false);
      default:
        return undefined;
    }
  };

  if (sections.length === 0) return null;

  return (
    <div ref={rootRef} className={cx('swalvo-device-menu', className)} data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="swalvo-button swalvo-device-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        {children ?? <ChevronIcon width={16} height={16} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={triggerLabel}
          className="swalvo-menu"
          onKeyDown={onMenuKeyDown}
        >
          {sections.map((sectionKind) => (
            <DeviceSection
              key={sectionKind}
              kind={sectionKind}
              room={room}
              showHeading={sections.length > 1}
              onError={onError}
              onItemsChange={focusInitialItem}
              onPicked={(deviceId) => {
                onActiveDeviceChange?.(sectionKind, deviceId);
                close(true);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])'));
}

function DeviceSection({
  kind,
  room,
  showHeading,
  onPicked,
  onError,
  onItemsChange,
}: {
  kind: DeviceKind;
  room?: Room;
  showHeading: boolean;
  onPicked: (deviceId: string) => void;
  onError?: (error: Error) => void;
  onItemsChange: () => void;
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, room, onError });
  const headingId = useId();
  // Before a grant the browser may not say which device is in use; treat the first as active.
  const active = activeDeviceId || devices[0]?.deviceId;
  useEffect(() => {
    onItemsChange();
  }, [devices, active, onItemsChange]);

  const pick = (deviceId: string) => {
    void setActiveMediaDevice(deviceId);
    onPicked(deviceId);
  };

  return (
    <div role="group" aria-labelledby={headingId} className="swalvo-menu__group" data-kind={kind}>
      <div id={headingId} className="swalvo-menu__heading" data-hidden={!showHeading || undefined}>
        {KIND_LABELS[kind]}
      </div>
      {devices.length === 0 ? (
        <div role="menuitemradio" aria-checked={false} aria-disabled="true" className="swalvo-menu__item" tabIndex={-1}>
          No {KIND_LABELS[kind].toLowerCase()} found
        </div>
      ) : (
        devices.map((device) => {
          const checked = device.deviceId === active;
          return (
            <div
              key={device.deviceId}
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={-1}
              className="swalvo-menu__item"
              data-active={checked || undefined}
              onClick={() => pick(device.deviceId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  pick(device.deviceId);
                }
              }}
            >
              {device.label}
            </div>
          );
        })
      )}
    </div>
  );
}
