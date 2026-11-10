import {
  Button,
  Loading,
  Menu,
  MenuItem,
  MenuTrigger,
  notify,
  RowInput,
} from '@affine/component';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import { ServerService } from '@affine/core/modules/cloud';
import { WorkspaceDialogService } from '@affine/core/modules/dialogs';
import {
  DocGrantedUsersService,
  MemberCandidateSearchService,
  MemberSearchService,
  WorkspaceMembersService,
} from '@affine/core/modules/permissions';
import { UserFriendlyError } from '@affine/error';
import {
  DocRole,
  ServerDeploymentType,
  WorkspaceMemberStatus,
} from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { track } from '@affine/track';
import { ArrowLeftBigIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import clsx from 'clsx';
import { debounce } from 'lodash-es';
import {
  type CompositionEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso } from 'react-virtuoso';

import { PlanTag } from '../plan-tag';
import { Scroller } from '../scroller';
import * as styles from './invite-member-editor.css';
import { MemberItem, type PickableMember } from './member-item';
import { SelectedMemberItem } from './selected-member-item';

const getRoleName = (role: DocRole, t: ReturnType<typeof useI18n>) => {
  switch (role) {
    case DocRole.Manager:
      return t['com.affine.share-menu.option.permission.can-manage']();
    case DocRole.Editor:
      return t['com.affine.share-menu.option.permission.can-edit']();
    case DocRole.Reader:
      return t['com.affine.share-menu.option.permission.can-read']();
    default:
      return '';
  }
};

/**
 * Self-hosted servers search every registered account and add the ones that
 * are not members yet to the workspace before granting the doc role; cloud
 * only searches existing workspace members.
 */
const useIsSelfhosted = () => {
  const serverService = useService(ServerService);
  return useLiveData(
    serverService.server.config$.selector(
      c => c.type === ServerDeploymentType.Selfhosted
    )
  );
};

export const InviteMemberEditor = ({
  openPaywallModal,
  hittingPaywall,
  onClickCancel,
}: {
  hittingPaywall: boolean;
  openPaywallModal: () => void;
  onClickCancel: () => void;
}) => {
  const t = useI18n();
  const [selectedMembers, setSelectedMembers] = useState<PickableMember[]>(
    []
  );
  const docGrantedUsersService = useService(DocGrantedUsersService);
  const membersService = useService(WorkspaceMembersService);
  const [inviteDocRoleType, setInviteDocRoleType] = useState<DocRole>(
    DocRole.Manager
  );

  const isSelfhosted = useIsSelfhosted();
  const memberSearchService = useService(MemberSearchService);
  const candidateSearchService = useService(MemberCandidateSearchService);
  const search = isSelfhosted ? candidateSearchService : memberSearchService;

  useEffect(() => {
    // reset the search text when the component is mounted
    search.reset();
    search.loadMore();
  }, [search]);

  const debouncedSearch = useMemo(
    () => debounce((value: string) => search.search(value), 300),
    [search]
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [searchText, setSearchText] = useState('');

  const handleValueChange = useCallback(
    (value: string) => {
      setSearchText(value);
      if (!composing) {
        debouncedSearch(value);
      }
    },
    [composing, debouncedSearch]
  );
  const workspaceDialogService = useService(WorkspaceDialogService);

  const onInvite = useAsyncCallback(async () => {
    const selectedMemberIds = selectedMembers.map(member => member.id);
    const newMemberIds = selectedMembers
      .filter(member => !member.isMember)
      .map(member => member.id);
    track.$.sharePanel.$.inviteUserDocRole({
      control: 'member list',
      role: inviteDocRoleType,
    });
    try {
      if (newMemberIds.length) {
        await membersService.addMembers(newMemberIds);
        membersService.members.revalidate();
      }
      await docGrantedUsersService.grantUsersRole(
        selectedMemberIds,
        inviteDocRoleType
      );
      onClickCancel();

      notify.success({
        title: newMemberIds.length
          ? t['com.affine.share-menu.invite-editor.added']()
          : t['Invitation sent'](),
      });
    } catch (error) {
      const err = UserFriendlyError.fromAny(error);
      notify.error({
        title: t[`error.${err.name}`](err.data),
      });
    }
  }, [
    docGrantedUsersService,
    inviteDocRoleType,
    membersService,
    onClickCancel,
    selectedMembers,
    t,
  ]);

  const handleCompositionStart: CompositionEventHandler<HTMLInputElement> =
    useCallback(() => {
      setComposing(true);
    }, []);

  const handleCompositionEnd: CompositionEventHandler<HTMLInputElement> =
    useCallback(
      e => {
        setComposing(false);
        debouncedSearch(e.currentTarget.value);
      },
      [debouncedSearch]
    );

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);
  const onFocus = useCallback(() => {
    setFocused(true);
  }, []);
  const onBlur = useCallback(() => {
    setFocused(false);
  }, []);

  const handleRemoved = useCallback(
    (memberId: string) => {
      setSelectedMembers(prev => prev.filter(member => member.id !== memberId));
      focusInput();
    },
    [focusInput]
  );

  const switchToMemberManagementTab = useCallback(() => {
    workspaceDialogService.open('setting', {
      activeTab: 'workspace:members',
    });
  }, [workspaceDialogService]);

  const handleClickMember = useCallback(
    (member: PickableMember) => {
      setSelectedMembers(prev => {
        if (prev.some(m => m.id === member.id)) {
          // if the member is already in the list, just return
          return prev;
        }
        return [...prev, member];
      });
      setSearchText('');
      search.search('');
      focusInput();
    },
    [focusInput, search]
  );

  const handleRoleChange = useCallback((role: DocRole) => {
    setInviteDocRoleType(role);
  }, []);

  return (
    <div className={styles.containerStyle}>
      <div className={styles.headerStyle} onClick={onClickCancel}>
        <ArrowLeftBigIcon className={styles.iconStyle} />
        {t['com.affine.share-menu.invite-editor.header']()}
      </div>
      <div className={styles.memberListStyle}>
        <div
          className={clsx(styles.InputContainer, {
            focus: focused,
          })}
        >
          <div className={styles.inlineMembersContainer}>
            {selectedMembers.map((member, idx) => {
              if (!member) {
                return null;
              }
              const onRemoved = () => handleRemoved(member.id);
              return (
                <SelectedMemberItem
                  key={member.id}
                  idx={idx}
                  onRemoved={onRemoved}
                  member={member}
                />
              );
            })}
            <RowInput
              ref={inputRef}
              value={searchText}
              onChange={handleValueChange}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onFocus={onFocus}
              onBlur={onBlur}
              autoFocus
              className={styles.searchInput}
              placeholder={
                selectedMembers.length
                  ? ''
                  : t['com.affine.share-menu.invite-editor.placeholder']()
              }
            />
          </div>
          {!selectedMembers.length ? null : (
            <RoleSelector
              openPaywallModal={openPaywallModal}
              hittingPaywall={hittingPaywall}
              inviteDocRoleType={inviteDocRoleType}
              onRoleChange={handleRoleChange}
            />
          )}
        </div>
        <div className={styles.resultContainer}>
          {isSelfhosted ? (
            <CandidateResult onClickMember={handleClickMember} />
          ) : (
            <MemberResult onClickMember={handleClickMember} />
          )}
        </div>
      </div>
      <div className={styles.footerStyle}>
        <span
          className={styles.manageMemberStyle}
          onClick={switchToMemberManagementTab}
        >
          {t['com.affine.share-menu.invite-editor.manage-members']()}
        </span>
        <div className={styles.buttonsContainer}>
          <Button className={styles.button} onClick={onClickCancel}>
            {t['Cancel']()}
          </Button>
          <Button
            className={styles.button}
            variant="primary"
            disabled={!selectedMembers.length}
            onClick={onInvite}
          >
            {t['com.affine.share-menu.invite-editor.invite']()}
          </Button>
        </div>
      </div>
    </div>
  );
};

const ResultList = ({
  searchText,
  isLoading,
  members,
  onClickMember,
  loadMore,
}: {
  searchText: string;
  isLoading: boolean;
  members: PickableMember[];
  onClickMember: (member: PickableMember) => void;
  loadMore: () => void;
}) => {
  const t = useI18n();

  const itemContentRenderer = useCallback(
    (_index: number, data: PickableMember) => {
      return (
        <MemberItem
          member={data}
          hint={
            data.isMember
              ? undefined
              : t['com.affine.share-menu.invite-editor.add-to-workspace']()
          }
          onSelect={onClickMember}
        />
      );
    },
    [onClickMember, t]
  );

  if (!searchText) {
    return null;
  }

  if (members.length === 0) {
    if (isLoading) {
      return <Loading />;
    }
    return (
      <div className={styles.noFound}>
        {t['com.affine.share-menu.invite-editor.no-found']()}
      </div>
    );
  }

  return members.length < 8 ? (
    <div>
      {members.map((member, index) => (
        <div key={member.id}>{itemContentRenderer(index, member)}</div>
      ))}
    </div>
  ) : (
    <Virtuoso
      components={{
        Scroller,
      }}
      data={members}
      itemContent={itemContentRenderer}
      endReached={loadMore}
    />
  );
};

const MemberResult = ({
  onClickMember,
}: {
  onClickMember: (member: PickableMember) => void;
}) => {
  const memberSearchService = useService(MemberSearchService);
  const searchText = useLiveData(memberSearchService.searchText$);
  const result = useLiveData(memberSearchService.result$);
  const isLoading = useLiveData(memberSearchService.isLoading$);

  const activeMembers = useMemo<PickableMember[]>(() => {
    return result
      .filter(member => member.status === WorkspaceMemberStatus.Accepted)
      .map(member => ({ ...member, isMember: true }));
  }, [result]);

  const loadMore = useCallback(() => {
    memberSearchService.loadMore();
  }, [memberSearchService]);

  return (
    <ResultList
      searchText={searchText}
      isLoading={isLoading}
      members={activeMembers}
      onClickMember={onClickMember}
      loadMore={loadMore}
    />
  );
};

const CandidateResult = ({
  onClickMember,
}: {
  onClickMember: (member: PickableMember) => void;
}) => {
  const candidateSearchService = useService(MemberCandidateSearchService);
  const searchText = useLiveData(candidateSearchService.searchText$);
  const result = useLiveData(candidateSearchService.result$);
  const isLoading = useLiveData(candidateSearchService.isLoading$);

  const candidates = useMemo<PickableMember[]>(() => {
    return result.map(candidate => ({
      ...candidate,
      isMember: candidate.status === WorkspaceMemberStatus.Accepted,
    }));
  }, [result]);

  const loadMore = useCallback(() => {
    candidateSearchService.loadMore();
  }, [candidateSearchService]);

  return (
    <ResultList
      searchText={searchText}
      isLoading={isLoading}
      members={candidates}
      onClickMember={onClickMember}
      loadMore={loadMore}
    />
  );
};

const RoleSelector = ({
  openPaywallModal,
  hittingPaywall,
  inviteDocRoleType,
  onRoleChange,
}: {
  openPaywallModal: () => void;
  inviteDocRoleType: DocRole;
  onRoleChange: (role: DocRole) => void;
  hittingPaywall: boolean;
}) => {
  const t = useI18n();
  const currentRoleName = useMemo(
    () => getRoleName(inviteDocRoleType, t),
    [inviteDocRoleType, t]
  );

  const changeToAdmin = useCallback(
    () => onRoleChange(DocRole.Manager),
    [onRoleChange]
  );
  const changeToWrite = useCallback(() => {
    if (hittingPaywall) {
      openPaywallModal();
      return;
    }
    onRoleChange(DocRole.Editor);
  }, [hittingPaywall, onRoleChange, openPaywallModal]);
  const changeToRead = useCallback(() => {
    if (hittingPaywall) {
      openPaywallModal();
      return;
    }
    onRoleChange(DocRole.Reader);
  }, [hittingPaywall, onRoleChange, openPaywallModal]);
  return (
    <div className={styles.roleSelectorContainer}>
      <Menu
        contentOptions={{
          align: 'end',
        }}
        items={
          <>
            <MenuItem
              onSelect={changeToAdmin}
              selected={inviteDocRoleType === DocRole.Manager}
            >
              {t['com.affine.share-menu.option.permission.can-manage']()}
            </MenuItem>
            <MenuItem
              onSelect={changeToWrite}
              selected={inviteDocRoleType === DocRole.Editor}
            >
              <div className={styles.planTagContainer}>
                {t['com.affine.share-menu.option.permission.can-edit']()}
                {hittingPaywall ? <PlanTag /> : null}
              </div>
            </MenuItem>
            <MenuItem
              onSelect={changeToRead}
              selected={inviteDocRoleType === DocRole.Reader}
            >
              <div className={styles.planTagContainer}>
                {t['com.affine.share-menu.option.permission.can-read']()}
                {hittingPaywall ? <PlanTag /> : null}
              </div>
            </MenuItem>
          </>
        }
      >
        <MenuTrigger
          className={styles.menuTriggerStyle}
          variant="plain"
          contentStyle={{
            width: '100%',
          }}
        >
          {currentRoleName}
        </MenuTrigger>
      </Menu>
    </div>
  );
};
