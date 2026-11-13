import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

import styles from './Panel.module.css';

export type PanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
};

export function Panel({
  title,
  subtitle,
  actions,
  flush = false,
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <section className={clsx(styles.panel, className)} {...rest}>
      {title || subtitle || actions ? (
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            {title ? <h3 className={styles.title}>{title}</h3> : null}
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={clsx(styles.body, flush && styles.bodyFlush)}>{children}</div>
    </section>
  );
}
