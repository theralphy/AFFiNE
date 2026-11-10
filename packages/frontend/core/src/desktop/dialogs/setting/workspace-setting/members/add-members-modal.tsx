import {
  Avatar,
  Button,
  Checkbox,
  ConfirmModal,
  Input,
  Loading,
} from '@affine/component';
import {
  type MemberCandidate,
  MemberCandidateSearchService,
} from '@affine/core/modules/permissions';
import { WorkspaceMemberStatus } from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { useLiveData, useService } from '@toeverything/infra';
import { debounce } from 'lodash-es';
import { useCallback, useEffect, useMemo, useState } from 'react';

import * as styles from './add-members-modal.css';

/**
 * Self-hosted replacement for the email/link invite modal: pick accounts that
 * already exist on the server and add them to the workspace directly.
 */
export const AddMembersModal = ({
  open,
  setOpen,
  onConfirm,
  isMutating,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  onConfirm: (userIds: string[]) => void;
  isMutating: boolean;
}) => {
  const t = useI18n();
  const search = useService(MemberCandidateSearchService);
  const result = useLiveData(search.result$);
  const isLoading = useLiveData(search.isLoading$);
  const hasMore = useLiveData(search.hasMore$);
  const [searchText, setSearchText] = useState('');
  const [selected, setSelected] = useState<Map<string, MemberCandidate>>(
    () => new Map()
  );

  useEffect(() => {
    if (open) {
      setSearchText('');
      setSelected(new Map());
      search.search('');
    }
  }, [open, search]);

  const debouncedSearch = useMemo(
    () => debounce((value: string) => search.search(value), 300),
    [search]
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchText(value);
      debouncedSearch(value);
    },
    [debouncedSearch]
  );

  const toggle = useCallback((candidate: MemberCandidate) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(candidate.id)) {
        next.delete(candidate.id);
      } else {
        next.set(candidate.id, candidate);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(Array.from(selected.keys()));
  }, [onConfirm, selected]);

  const loadMore = useCallback(() => {
    search.loadMore();
  }, [search]);

  return (
    <ConfirmModal
      width={480}
      open={open}
      onOpenChange={setOpen}
      title={t['com.affine.payment.member.add.title']()}
      cancelText={t['com.affine.inviteModal.button.cancel']()}
      cancelButtonOptions={{ variant: 'secondary' }}
      contentOptions={{
        ['data-testid' as string]: 'add-members-modal',
        style: { padding: '20px 24px' },
      }}
      confirmText={t['com.affine.payment.member.add.confirm']()}
      confirmButtonOptions={{
        loading: isMutating,
        variant: 'primary',
        disabled: selected.size === 0,
      }}
      onConfirm={handleConfirm}
    >
      <div className={styles.content}>
        <div className={styles.description}>
          {t['com.affine.payment.member.add.description']()}
        </div>
        <Input
          autoFocus
          value={searchText}
          onChange={handleSearchChange}
          placeholder={t['com.affine.payment.member.add.placeholder']()}
        />
        <div className={styles.list}>
          {result.map(candidate => {
            const isMember =
              candidate.status === WorkspaceMemberStatus.Accepted;
            const checked = selected.has(candidate.id);
            return (
              <div
                key={candidate.id}
                className={styles.row}
                data-disabled={isMember}
                onClick={() => {
                  if (!isMember) toggle(candidate);
                }}
              >
                {/* the row handles clicks; the checkbox only shows state */}
                <Checkbox checked={isMember || checked} disabled={isMember} />
                <Avatar
                  url={candidate.avatarUrl || ''}
                  name={candidate.name}
                  size={32}
                />
                <div className={styles.info}>
                  <div className={styles.name}>{candidate.name}</div>
                  <div className={styles.email}>{candidate.email}</div>
                </div>
                {isMember ? (
                  <div className={styles.status}>{t['Members']()}</div>
                ) : null}
              </div>
            );
          })}
          {isLoading ? (
            <Loading />
          ) : result.length === 0 ? (
            <div className={styles.empty}>
              {t['com.affine.share-menu.invite-editor.no-found']()}
            </div>
          ) : hasMore ? (
            <Button
              className={styles.loadMore}
              variant="plain"
              onClick={loadMore}
            >
              {t['com.affine.payment.member.add.load-more']()}
            </Button>
          ) : null}
        </div>
      </div>
    </ConfirmModal>
  );
};
