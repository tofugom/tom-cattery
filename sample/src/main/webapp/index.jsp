<%@ page contentType="text/html;charset=UTF-8" language="java" %>
<!DOCTYPE html>
<html>
<head>
    <title>Tom Cattery Sample</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
        h1 { color: #e67e22; }
        a { color: #2980b9; }
        .info { background: #f5f5f5; padding: 16px; border-radius: 8px; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>Tom Cattery Sample App</h1>
    <p>WAR deployed successfully!</p>

    <div class="info">
        <p><strong>Server:</strong> <%= application.getServerInfo() %></p>
        <p><strong>Time:</strong> <%= new java.util.Date() %></p>
        <p><strong>Context Path:</strong> <%= request.getContextPath().isEmpty() ? "/" : request.getContextPath() %></p>
    </div>

    <p><a href="hello">Go to HelloServlet</a></p>
</body>
</html>
