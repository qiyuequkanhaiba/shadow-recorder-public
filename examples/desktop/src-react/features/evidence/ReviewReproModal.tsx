import React from 'react';
import { Button } from '../../ui/Button';
import styles from './RecordingReview.module.css';

export type ReviewReproModalProps = {
  isOpen: boolean;
  reproText: string;
  onClose: () => void;
  onCopy: () => void;
};

export function ReviewReproModal({
  isOpen,
  reproText,
  onClose,
  onCopy,
}: ReviewReproModalProps) {
  if (!isOpen) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>缺陷复现步骤文本</h4>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>
        <pre className={styles.reproCode}>{reproText || '暂无可导出的复现步骤。'}</pre>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="primary" size="sm" onClick={onCopy}>
            复制全文
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
