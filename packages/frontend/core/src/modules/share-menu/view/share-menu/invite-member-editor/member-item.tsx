import { Avatar } from '@affine/component';
import { useCallback } from 'react';

import * as styles from './member-item.css';

export type PickableMember = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** false when the account exists on the server but not in this workspace */
  isMember: boolean;
};

export const MemberItem = ({
  member,
  hint,
  onSelect,
}: {
  member: PickableMember;
  hint?: string;
  onSelect: (item: PickableMember) => void;
}) => {
  const handleSelect = useCallback(() => {
    onSelect(member);
  }, [member, onSelect]);
  return (
    <div className={styles.memberItemStyle} onClick={handleSelect}>
      <div className={styles.memberContainerStyle}>
        <Avatar
          key={member.id}
          url={member.avatarUrl || ''}
          name={member.name || ''}
          size={36}
        />
        <div className={styles.memberInfoStyle}>
          <div className={styles.memberNameStyle}>{member.name}</div>
          <div className={styles.memberEmailStyle}>{member.email}</div>
          {hint ? <div className={styles.memberHintStyle}>{hint}</div> : null}
        </div>
      </div>
    </div>
  );
};
