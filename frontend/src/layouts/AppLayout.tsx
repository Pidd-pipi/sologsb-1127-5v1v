import { useEffect } from 'react';
import { Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  HomeOutlined,
  PlusCircleOutlined,
  EnvironmentOutlined,
  NodeIndexOutlined,
  SwapOutlined,
  ToolOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { useSyncStore } from '../sync/syncStore';

const { Sider, Content, Header } = Layout;

const MENU = [
  { key: '/', icon: <HomeOutlined />, label: '核验总览' },
  { key: '/points/new', icon: <PlusCircleOutlined />, label: '点位登记' },
  { key: '/routes', icon: <NodeIndexOutlined />, label: '通行路线' },
  { key: '/map', icon: <EnvironmentOutlined />, label: '设施地图' },
  { key: '/rectify', icon: <ToolOutlined />, label: '整改清单' },
  { key: '/handoff', icon: <SwapOutlined />, label: '现场交接' },
];

export default function AppLayout() {
  const location = useLocation();
  const loadPoints = usePointStore((s) => s.load);
  const loadRoutes = useRouteStore((s) => s.load);
  const pointCount = usePointStore((s) => s.points.length);
  const inspectionCount = usePointStore((s) => s.inspections.length);
  const initSync = useSyncStore((s) => s.init);
  const refreshCounts = useSyncStore((s) => s.refreshCounts);
  const reloadPoints = usePointStore((s) => s.reload);
  const reloadRoutes = useRouteStore((s) => s.load);
  const online = useSyncStore((s) => s.online);
  const phase = useSyncStore((s) => s.phase);
  const outboxCount = useSyncStore((s) => s.outboxCount);
  const pendingConflictCount = useSyncStore((s) => s.pendingConflictCount);
  const hasKey = Boolean((import.meta.env.VITE_AMAP_KEY || '').trim());

  useEffect(() => {
    void loadPoints();
    void loadRoutes();
    void (async () => {
      await initSync();
      await refreshCounts();
      await reloadPoints();
      await reloadRoutes();
    })();
    // 每 5 秒刷新顶栏待提交/待裁决角标
    const timer = setInterval(() => void refreshCounts(), 5000);
    return () => clearInterval(timer);
  }, [loadPoints, loadRoutes, initSync, refreshCounts, reloadPoints, reloadRoutes]);

  const selectedKey =
    MENU.map((m) => m.key)
      .filter((k) => k !== '/' && location.pathname.startsWith(k))
      .sort((a, b) => b.length - a.length)[0] || '/';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div className="gb-logo">
          <DatabaseOutlined style={{ fontSize: 20 }} />
          <div>
            <div className="gb-logo-title">无障碍设施核验</div>
            <div className="gb-logo-sub">gbaccessmap</div>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU.map((m) => ({
            key: m.key,
            icon: m.icon,
            label: <Link to={m.key}>{m.label}</Link>,
          }))}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #eef1f5',
          }}
        >
          <Typography.Title level={5} style={{ margin: 0 }}>
            城市无障碍设施核验地图
          </Typography.Title>
          <Space size={8}>
            <Tag color="blue" data-testid="count-points">
              点位 {pointCount}
            </Tag>
            <Tag color="cyan" data-testid="count-inspections">
              核验 {inspectionCount}
            </Tag>
            <Tag color={online ? 'green' : 'red'} data-testid="net-status-tag">
              {phase === 'syncing' ? '同步中' : online ? '在线' : '断网本机保存'}
            </Tag>
            {outboxCount > 0 ? (
              <Link to="/handoff">
                <Tag color="gold" data-testid="outbox-tag">
                  待合并 {outboxCount}
                </Tag>
              </Link>
            ) : null}
            {pendingConflictCount > 0 ? (
              <Link to="/handoff">
                <Tag color="volcano" data-testid="conflict-tag">
                  待裁决 {pendingConflictCount}
                </Tag>
              </Link>
            ) : null}
            <Tag color={hasKey ? 'green' : 'orange'} data-testid="amap-key-tag">
              {hasKey ? '高德地图已配置' : '网格降级模式'}
            </Tag>
          </Space>
        </Header>
        <Content>
          <div className="gb-content">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
