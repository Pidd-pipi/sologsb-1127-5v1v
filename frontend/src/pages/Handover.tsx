import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudSyncOutlined,
  FlagOutlined,
  ReloadOutlined,
  SwapOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { SUPERVISORS, useHandoverStore } from '../stores/handoverStore';
import { usePointStore } from '../stores/pointStore';
import type { ConflictRecord, Region } from '../types/handover';
import { ENTITY_LABELS, FIELD_LABELS, formatConflictValue } from '../types/handover';

function timeOf(iso?: string): string {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(0, 19);
}

/** 区域认领页签：同一区域只能一人接管，其余排队并看到接管人 */
function RegionPanel() {
  const { message } = App.useApp();
  const user = useHandoverStore((s) => s.user);
  const regions = useHandoverStore((s) => s.regions);
  const online = useHandoverStore((s) => s.online);
  const claim = useHandoverStore((s) => s.claim);
  const release = useHandoverStore((s) => s.release);
  const leaveQueue = useHandoverStore((s) => s.leaveQueue);
  const [busy, setBusy] = useState('');

  const run = async (regionNo: string, action: () => Promise<unknown>) => {
    setBusy(regionNo);
    try {
      await action();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const handleClaim = (regionNo: string) =>
    run(regionNo, async () => {
      const res = await claim(regionNo);
      if (res.result === 'claimed') {
        message.success(`已接管 ${regionNo}`);
      } else {
        message.info(
          `${regionNo} 已由 ${res.holder.userName} 接管，你已排在第 ${res.position} 位`,
        );
      }
    });

  const columns: ColumnsType<Region> = [
    { title: '区域编号', dataIndex: 'regionNo', width: 110 },
    { title: '区域名称', dataIndex: 'name', width: 130 },
    {
      title: '当前接管人',
      key: 'holder',
      render: (_, r) =>
        r.holder ? (
          <Space size={6} wrap>
            <Typography.Text strong>{r.holder.userName}</Typography.Text>
            <Typography.Text type="secondary" className="gb-muted">
              {timeOf(r.holder.claimedAt)}
            </Typography.Text>
            {r.holder.userId === user.userId ? <Tag color="green">我</Tag> : null}
          </Space>
        ) : (
          <Tag>待认领</Tag>
        ),
    },
    {
      title: '排队',
      key: 'queue',
      render: (_, r) =>
        r.queue.length ? (
          <Space size={4} wrap>
            {r.queue.map((q, i) => (
              <Tag key={q.userId} color={q.userId === user.userId ? 'gold' : 'default'}>
                {i + 1}. {q.userName}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">无人排队</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, r) => {
        const mine = r.holder?.userId === user.userId;
        const myPos = r.queue.findIndex((q) => q.userId === user.userId);
        return (
          <Space size={8} wrap>
            {mine ? (
              <Button
                size="small"
                loading={busy === r.regionNo}
                onClick={() => run(r.regionNo, () => release(r.regionNo))}
                data-testid={`release-${r.regionNo}`}
              >
                释放
              </Button>
            ) : (
              <Button
                size="small"
                type="primary"
                disabled={!online}
                loading={busy === r.regionNo}
                onClick={() => handleClaim(r.regionNo)}
                data-testid={`claim-${r.regionNo}`}
              >
                认领
              </Button>
            )}
            {myPos >= 0 ? (
              <>
                <Tag color="gold">第 {myPos + 1} 位</Tag>
                <Button
                  size="small"
                  loading={busy === r.regionNo}
                  onClick={() => run(r.regionNo, () => leaveQueue(r.regionNo))}
                  data-testid={`leave-${r.regionNo}`}
                >
                  退出排队
                </Button>
              </>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      size="small"
      title="区域认领（同一区域同一时刻仅一人接管，其余自动排队）"
      data-testid="region-panel"
    >
      <Table<Region>
        rowKey="regionNo"
        size="small"
        pagination={false}
        dataSource={regions}
        columns={columns}
        locale={{ emptyText: <Empty description="离线状态下无法加载区域，恢复网络后自动刷新" /> }}
      />
    </Card>
  );
}

/** 离线同步页签：断网改动留本机，恢复后一键 / 自动合并 */
function SyncPanel() {
  const online = useHandoverStore((s) => s.online);
  const syncing = useHandoverStore((s) => s.syncing);
  const lastSyncAt = useHandoverStore((s) => s.lastSyncAt);
  const lastSyncResult = useHandoverStore((s) => s.lastSyncResult);
  const dirtyCount = useHandoverStore((s) => s.dirtyCount);
  const syncNow = useHandoverStore((s) => s.syncNow);
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const conflicts = useHandoverStore((s) => s.conflicts);
  const pendingConflicts = conflicts.filter((c) => c.status === 'pending').length;

  return (
    <Card size="small" title="离线同步（断网改动保存在本机，恢复网络后按点位编号合并）">
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Statistic title="待同步改动（本机）" value={dirtyCount} suffix="条" data-testid="dirty-count" />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="待裁决冲突" value={pendingConflicts} suffix="条" />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="本地点位 / 核验 / 整改" value={`${points.length} / ${inspections.length} / ${rectifies.length}`} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="上次同步" value={lastSyncAt ? timeOf(lastSyncAt) : '尚未同步'} />
        </Col>
      </Row>
      <Space direction="vertical" size={8} style={{ marginTop: 16, width: '100%' }}>
        <Space wrap>
          <Button
            type="primary"
            icon={<CloudSyncOutlined />}
            loading={syncing}
            disabled={!online}
            onClick={() => void syncNow()}
            data-testid="sync-now"
          >
            {syncing ? '正在合并…' : '立即同步'}
          </Button>
          {!online ? <Tag color="orange">当前离线：改动会继续保存在本机，恢复网络后自动同步</Tag> : null}
        </Space>
        {lastSyncResult ? (
          <Typography.Text type="secondary" data-testid="sync-result">
            {lastSyncResult}
          </Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}

/** 冲突裁决页签：两份值并列展示来源，裁决前点位不进总览和地图 */
function ConflictPanel() {
  const { message } = App.useApp();
  const conflicts = useHandoverStore((s) => s.conflicts);
  const resolveConflict = useHandoverStore((s) => s.resolveConflict);
  const [busy, setBusy] = useState('');

  const pending = useMemo(() => conflicts.filter((c) => c.status === 'pending'), [conflicts]);
  const resolved = useMemo(
    () => conflicts.filter((c) => c.status === 'resolved').slice(-20).reverse(),
    [conflicts],
  );

  const handleResolve = async (id: string, choice: 'server' | 'local') => {
    setBusy(id);
    try {
      await resolveConflict(id, choice);
      message.success(choice === 'local' ? '已采用上报值' : '已保留服务端值');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const columns: ColumnsType<ConflictRecord> = [
    {
      title: '点位',
      key: 'point',
      width: 200,
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{c.pointCode}</Typography.Text>
          <Typography.Text type="secondary" className="gb-muted">
            {c.pointName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '数据 / 字段',
      key: 'field',
      width: 140,
      render: (_, c) => (
        <Space size={4} wrap>
          <Tag>{ENTITY_LABELS[c.entity]}</Tag>
          <span>{FIELD_LABELS[c.field] ?? c.field}</span>
        </Space>
      ),
    },
    {
      title: '服务端值',
      key: 'serverValue',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{formatConflictValue(c.serverValue)}</Typography.Text>
          <Typography.Text type="secondary" className="gb-muted">
            来源：{c.serverSource.userName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '上报值',
      key: 'localValue',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{formatConflictValue(c.localValue)}</Typography.Text>
          <Typography.Text type="secondary" className="gb-muted">
            来源：{c.localSource.userName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '裁决',
      key: 'actions',
      width: 210,
      render: (_, c) => (
        <Space size={8} wrap>
          <Button
            size="small"
            loading={busy === c.id}
            onClick={() => void handleResolve(c.id, 'server')}
            data-testid={`keep-server-${c.id}`}
          >
            保留服务端
          </Button>
          <Button
            size="small"
            type="primary"
            loading={busy === c.id}
            onClick={() => void handleResolve(c.id, 'local')}
            data-testid={`take-local-${c.id}`}
          >
            采用上报值
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space size={8}>
            <span>待裁决冲突</span>
            <Badge count={pending.length} data-testid="pending-conflict-count" />
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" className="gb-muted" style={{ marginTop: 0 }}>
          同一字段两边都改过时，两份值都保留在此并标出来源；裁决前对应点位不进入总览和地图。
        </Typography.Paragraph>
        <Table<ConflictRecord>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={pending}
          columns={columns}
          locale={{ emptyText: <Empty description="没有待裁决的冲突" /> }}
          data-testid="pending-conflicts"
        />
      </Card>
      {resolved.length ? (
        <Card size="small" title={`最近已裁决（${resolved.length}）`}>
          <Table<ConflictRecord>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={resolved}
            columns={[
              { title: '点位', dataIndex: 'pointCode', width: 140 },
              {
                title: '字段',
                key: 'field',
                width: 120,
                render: (_, c) => FIELD_LABELS[c.field] ?? c.field,
              },
              {
                title: '裁决结果',
                key: 'resolution',
                render: (_, c) =>
                  c.resolution ? (
                    <Space size={6} wrap>
                      <Tag color={c.resolution.choice === 'local' ? 'blue' : 'default'}>
                        {c.resolution.choice === 'local' ? '采用上报值' : '保留服务端'}
                      </Tag>
                      <span>{formatConflictValue(c.resolution.appliedValue)}</span>
                      <Typography.Text type="secondary" className="gb-muted">
                        {c.resolution.resolvedBy.userName} · {timeOf(c.resolution.resolvedAt)}
                      </Typography.Text>
                    </Space>
                  ) : null,
              },
            ]}
          />
        </Card>
      ) : null}
    </Space>
  );
}

export default function Handover() {
  const user = useHandoverStore((s) => s.user);
  const setUser = useHandoverStore((s) => s.setUser);
  const online = useHandoverStore((s) => s.online);
  const dirtyCount = useHandoverStore((s) => s.dirtyCount);
  const conflicts = useHandoverStore((s) => s.conflicts);
  const loadRegions = useHandoverStore((s) => s.loadRegions);
  const loadConflicts = useHandoverStore((s) => s.loadConflicts);
  const refreshDirtyCount = useHandoverStore((s) => s.refreshDirtyCount);
  const pendingCount = conflicts.filter((c) => c.status === 'pending').length;

  useEffect(() => {
    void refreshDirtyCount();
  }, [refreshDirtyCount]);

  // 在线时每 5 秒刷新区域与冲突，排队者能及时看到接管人变化
  useEffect(() => {
    if (!online) return undefined;
    const refresh = () => {
      void loadRegions().catch(() => undefined);
      void loadConflicts().catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [online, loadRegions, loadConflicts]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线核验交接</h1>
          <Typography.Text type="secondary">
            分组进楼前认领区域；现场断网改动保存在本机，恢复网络后按点位编号合并，冲突裁决前不进总览和地图。
          </Typography.Text>
        </div>
        <Space wrap>
          <Tag color={online ? 'green' : 'orange'} data-testid="net-status">
            {online ? '在线' : '离线'}
          </Tag>
          <Space size={4}>
            <UserSwitchOutlined />
            <Select
              size="small"
              style={{ width: 150 }}
              value={user.userId}
              onChange={(id) => {
                const next = SUPERVISORS.find((u) => u.userId === id);
                if (next) setUser(next);
              }}
              options={SUPERVISORS.map((u) => ({ value: u.userId, label: u.userName }))}
              data-testid="user-switch"
            />
          </Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            disabled={!online}
            onClick={() => {
              void loadRegions().catch(() => undefined);
              void loadConflicts().catch(() => undefined);
            }}
          >
            刷新
          </Button>
        </Space>
      </div>

      <Tabs
        defaultActiveKey="regions"
        items={[
          {
            key: 'regions',
            label: (
              <Space size={4}>
                <FlagOutlined />
                区域认领
              </Space>
            ),
            children: <RegionPanel />,
          },
          {
            key: 'sync',
            label: (
              <Space size={4}>
                <SwapOutlined />
                离线同步
                <Badge count={dirtyCount} size="small" />
              </Space>
            ),
            children: <SyncPanel />,
          },
          {
            key: 'conflicts',
            label: (
              <Space size={4}>
                冲突裁决
                <Badge count={pendingCount} size="small" />
              </Space>
            ),
            children: <ConflictPanel />,
          },
        ]}
      />
    </div>
  );
}
