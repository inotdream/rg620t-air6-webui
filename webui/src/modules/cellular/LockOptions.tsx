import React from 'react';
import { Checkbox } from '@douyinfe/semi-ui';
import type { LockKind } from './lockApply';

export default function LockOptions({ kind, onKind, apply, onApply, disabled, unlocking = false }: {
  kind?: LockKind; onKind?: (kind: LockKind) => void;
  apply: boolean; onApply: (apply: boolean) => void; disabled?: boolean; unlocking?: boolean;
}) {
  return (
    <div className="lock-options">
      {kind && onKind && (
        <div className="segmented-control" role="radiogroup" aria-label="锁定方式">
          {(['cell', 'arfcn'] as const).map((value) => (
            <button type="button" key={value} role="radio" aria-checked={kind === value} disabled={disabled}
              className={`segmented-btn${kind === value ? ' is-active' : ''}`} onClick={() => onKind(value)}>
              {value === 'cell' ? '锁主小区（频点 + PCI）' : '只锁频点'}
            </button>
          ))}
        </div>
      )}
      <Checkbox checked={apply} disabled={disabled} onChange={(e) => onApply(!!e.target.checked)}>
        {unlocking ? '解除后立即重新驻留' : '立即重新驻留'}（射频重启，蜂窝连接会中断）
      </Checkbox>
    </div>
  );
}
