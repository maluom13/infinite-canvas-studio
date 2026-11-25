import { Component, type ReactNode } from "react";

type PluginErrorBoundaryProps = {
    children: ReactNode;
    fallback: ReactNode;
    // 节点或插件版本变化时重置，插件修好后不用刷新整页。
    resetKey?: string;
};

type PluginErrorBoundaryState = { failed: boolean };

/** 插件渲染抛错时只替换这一块内容，避免整块画布白屏、未保存的编辑一起丢失。 */
export class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
    state: PluginErrorBoundaryState = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.error("Plugin render failed", error);
    }

    componentDidUpdate(previous: PluginErrorBoundaryProps) {
        if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}
