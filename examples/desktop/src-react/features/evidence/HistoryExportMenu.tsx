import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import styles from './HistoryExportMenu.module.css';

export type HistoryExportMenuProps = {
  disabled?: boolean;
  isExporting?: boolean;
  hasSegment?: boolean;
  segmentLabel?: string;
  onExportAll: () => void;
  onExportSegment?: () => void;
};

export function HistoryExportMenu({
  disabled,
  isExporting,
  hasSegment,
  segmentLabel = '导出当前切片',
  onExportAll,
  onExportSegment,
}: HistoryExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleTriggerClick = () => {
    setIsOpen((prev) => !prev);
  };

  useEffect(() => {
    if (isOpen) {
      // Focus first item when opened
      itemsRef.current[0]?.focus();
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }

    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;

    const currentIndex = items.findIndex((item) => item === document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % items.length;
      items[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (currentIndex - 1 + items.length) % items.length;
      items[prevIndex]?.focus();
    }
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        isOpen &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  return (
    <div className={styles.menuWrapper} onKeyDown={handleKeyDown}>
      <Button
        ref={triggerRef}
        variant="primary"
        size="sm"
        disabled={disabled || isExporting}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleTriggerClick}
        title="导出录像会话或切片"
      >
        {isExporting ? '正在导出…' : '导出 ▾'}
      </Button>

      {isOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="导出选项"
          className={styles.menuDropdown}
        >
          <button
            ref={(el) => { itemsRef.current[0] = el; }}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              closeMenu();
              onExportAll();
            }}
          >
            <span>导出整场会话全部切片</span>
          </button>

          {hasSegment && onExportSegment ? (
            <button
              ref={(el) => { itemsRef.current[1] = el; }}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                closeMenu();
                onExportSegment();
              }}
            >
              <span>{segmentLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
