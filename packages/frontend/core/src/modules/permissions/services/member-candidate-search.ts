import type { WorkspaceMemberCandidatesQuery } from '@affine/graphql';
import {
  catchErrorInto,
  effect,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  Service,
  smartRetry,
} from '@toeverything/infra';
import { EMPTY, exhaustMap, tap } from 'rxjs';

import type { WorkspaceService } from '../../workspace';
import type { WorkspaceMembersStore } from '../stores/members';

export type MemberCandidate =
  WorkspaceMemberCandidatesQuery['workspaceMemberCandidates'][number];

/**
 * Searches every registered account on the server, not only workspace
 * members, so managers can add accounts to the workspace directly.
 * Only available on self-hosted servers.
 */
export class MemberCandidateSearchService extends Service {
  constructor(
    private readonly store: WorkspaceMembersStore,
    private readonly workspaceService: WorkspaceService
  ) {
    super();
  }

  readonly PAGE_SIZE = 8;
  readonly searchText$ = new LiveData<string>('');
  readonly isLoading$ = new LiveData(false);
  readonly error$ = new LiveData<any>(null);
  readonly result$ = new LiveData<MemberCandidate[]>([]);
  readonly hasMore$ = new LiveData(true);

  readonly loadMore = effect(
    exhaustMap(() => {
      if (!this.hasMore$.value) {
        return EMPTY;
      }
      return fromPromise(async signal => {
        return this.store.searchCandidates(
          this.workspaceService.workspace.id,
          this.searchText$.value || undefined,
          this.result$.value.length,
          this.PAGE_SIZE,
          signal
        );
      }).pipe(
        tap(candidates => {
          this.result$.setValue([...this.result$.value, ...candidates]);
          this.hasMore$.setValue(candidates.length === this.PAGE_SIZE);
        }),
        smartRetry(),
        catchErrorInto(this.error$),
        onStart(() => {
          this.isLoading$.setValue(true);
        }),
        onComplete(() => this.isLoading$.setValue(false))
      );
    })
  );

  reset() {
    this.result$.setValue([]);
    this.hasMore$.setValue(true);
    this.searchText$.setValue('');
    this.error$.setValue(null);
    this.loadMore.reset();
  }

  search(searchText?: string) {
    this.reset();
    this.searchText$.setValue(searchText ?? '');
    this.loadMore();
  }

  override dispose(): void {
    this.loadMore.unsubscribe();
  }
}
