import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
};

const toneMap: Record<BadgeTone, string> = {
  neutral: styles.toneNeutral,
  accent: styles.toneAccent,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span className={clsx(styles.badge, toneMap[tone], className)} {...rest}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
